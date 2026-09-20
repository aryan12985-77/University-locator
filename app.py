"""Campus Navigator Flask server.

Maintenance note:
- VGU remains the default campus in data/locations.json.
- Other campuses can be entered through /setup and are stored in SQLite.
- Frontend pages are in templates/; browser behavior is in static/js/.
"""

from flask import Flask, render_template, request, jsonify, abort, redirect, url_for, session
import sqlite3
import json
import re
import os
from datetime import timedelta
from werkzeug.security import generate_password_hash, check_password_hash

from occupancy import DemoOccupancySource, ManualOccupancySource
from occupancy.base import parse_observed_at
from occupancy.demo_source import facility_category
from occupancy.status import occupancy_status
from ml import InsufficientDataError, PredictionService
from ml.registry import ModelRegistry
from ml.storage import ensure_prediction_table, store_prediction

app = Flask(__name__)
app.secret_key = os.environ.get("SESSION_SECRET", "local-development-session-secret")
prediction_services = {}
prediction_metadata = {}

DEFAULT_CAMPUS = {
    "id": "vgu-jaipur",
    "slug": "vgu-jaipur",
    "name": "VGU Jaipur",
    "short_name": "VGU, JAIPUR",
    "center_lat": 26.8123,
    "center_lng": 75.8935,
    "zoom": 18,
    "radius_m": 650,
    "routing_mode": "vgu",
}

# Panorama scenes are intentionally allowlisted so only published campus
# scenes can be opened by URL. Add the next real photosphere here when it is
# captured and connected to an indoor hotspot.
PANORAMA_SCENES = {
    "lt-202": {
        "id": "lt-202",
        "title": "LT-202",
        "building": "Tech Block",
        "floor": "2nd Floor",
        "image": "/static/panoramas/lt-202.jpg",
        "haov": 360,
        "vaov": 120,
        "v_offset": 0,
    }
}


def panorama_for_location(name, campus_slug=None):
    """Return a published panorama URL for a location, if one exists."""
    campus = get_campus_config(campus_slug)
    if not campus or campus["routing_mode"] != "vgu":
        return ""
    scene = next(
        (scene for scene in PANORAMA_SCENES.values()
         if scene["title"].lower() == (name or "").lower()),
        None,
    )
    if not scene:
        return ""
    return url_for(
        "campus_panorama",
        slug=campus_slug or DEFAULT_CAMPUS["slug"],
        scene_id=scene["id"],
    )


def normalize_search(value):
    """Make searches tolerant of spaces, hyphens, underscores, and casing."""
    return re.sub(r"[^a-z0-9]", "", (value or "").casefold())


def location_matches(location, query):
    """Return a relevance score for flexible name/building/keyword matching."""
    needle = normalize_search(query)
    if not needle:
        return 0

    name = normalize_search(location["name"])
    building = normalize_search(location["building"])
    floor = normalize_search(location["floor"])
    keywords = normalize_search(location["keywords"])

    if needle == name:
        return 0
    if name.startswith(needle):
        return 1
    if needle in name:
        return 2
    if needle in building:
        return 3
    if needle in floor:
        return 4
    if needle in keywords:
        return 5
    return None


def find_locations(query, limit=None, campus_id=None):
    """Search one campus using the same flexible matching everywhere."""
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT name, building, floor, lat, lng,
               image, instructions, entry_lat, entry_lng, keywords
        FROM locations
        WHERE (? IS NULL OR campus_id = ?)
    """, (campus_id, campus_id)).fetchall()
    ranked = []
    for row in rows:
        location = dict(row)
        score = location_matches(location, query)
        if score is not None:
            ranked.append((score, location["name"].casefold(), location))
    if campus_id is not None:
        room_rows = conn.execute("""
            SELECT room.name, room.building, room.floor,
                   building.lat, building.lng, building.entry_lat,
                   building.entry_lng, room.keywords, room.instructions,
                   room.x AS room_x, room.y AS room_y
            FROM room_points AS room
            LEFT JOIN locations AS building
              ON building.campus_id = room.campus_id
             AND building.building = room.building
            WHERE room.campus_id = ?
        """, (campus_id,)).fetchall()
        for row in room_rows:
            location = dict(row)
            location.update({
                "image": "",
                "type": "room",
                "entry_lat": location.get("entry_lat") or location.get("lat"),
                "entry_lng": location.get("entry_lng") or location.get("lng"),
            })
            score = location_matches(location, query)
            if score is not None:
                ranked.append((score, location["name"].casefold(), location))
    ranked.sort(key=lambda item: (item[0], item[1]))
    locations = [item[2] for item in ranked]
    conn.close()
    return locations[:limit] if limit else locations


# Allow iframe embedding and disable cache for Replit preview
@app.after_request
def set_headers(response):
    response.headers["X-Frame-Options"] = "ALLOWALL"
    response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    response.headers["Pragma"] = "no-cache"
    response.headers["Expires"] = "0"
    return response


# ---------------- DATABASE CONNECTION ----------------
def get_db_connection():
    # Keeping the row factory lets routes convert database rows to JSON/dicts.
    conn = sqlite3.connect("campus.db")
    conn.row_factory = sqlite3.Row
    return conn


def ensure_schema():
    """Create the multi-campus schema and migrate the original VGU dataset."""
    conn = sqlite3.connect("campus.db")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS campus_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            campus_id TEXT NOT NULL,
            name TEXT NOT NULL,
            short_name TEXT NOT NULL,
            center_lat REAL NOT NULL,
            center_lng REAL NOT NULL,
            zoom INTEGER NOT NULL DEFAULT 17,
            radius_m REAL NOT NULL DEFAULT 1200,
            routing_mode TEXT NOT NULL DEFAULT 'generic'
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS campuses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            short_name TEXT NOT NULL,
            center_lat REAL NOT NULL,
            center_lng REAL NOT NULL,
            zoom INTEGER NOT NULL DEFAULT 17,
            radius_m REAL NOT NULL DEFAULT 1200,
            routing_mode TEXT NOT NULL DEFAULT 'generic',
            owner_password_hash TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS floor_plans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
            floor TEXT NOT NULL,
            title TEXT NOT NULL,
            image_url TEXT NOT NULL,
            width REAL NOT NULL DEFAULT 1000,
            height REAL NOT NULL DEFAULT 700,
            UNIQUE(campus_id, floor)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS room_points (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
            floor TEXT NOT NULL,
            name TEXT NOT NULL,
            building TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            keywords TEXT DEFAULT '',
            instructions TEXT DEFAULT '',
            UNIQUE(campus_id, floor, name, building)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS occupancy_observations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
            location_id INTEGER NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
            observed_at TEXT NOT NULL,
            observation_date TEXT NOT NULL,
            day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
            hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
            minute INTEGER NOT NULL CHECK (minute BETWEEN 0 AND 59),
            time_slot TEXT NOT NULL,
            total_capacity INTEGER NOT NULL CHECK (total_capacity > 0),
            occupied_count INTEGER NOT NULL CHECK (
                occupied_count BETWEEN 0 AND total_capacity
            ),
            available_count INTEGER NOT NULL CHECK (
                available_count = total_capacity - occupied_count
            ),
            occupancy_percentage REAL NOT NULL CHECK (
                occupancy_percentage BETWEEN 0 AND 100
            ),
            data_source TEXT NOT NULL,
            confidence REAL CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("""
        CREATE INDEX IF NOT EXISTS idx_occupancy_location_time
        ON occupancy_observations(campus_id, location_id, observed_at DESC)
    """)
    location_columns = {
        row[1] for row in conn.execute("PRAGMA table_info(locations)").fetchall()
    }
    if "campus_id" not in location_columns:
        conn.execute("ALTER TABLE locations ADD COLUMN campus_id INTEGER")
    conn.execute("DROP INDEX IF EXISTS unique_location")
    existing_settings = conn.execute("""
        SELECT campus_id, name, short_name, center_lat, center_lng,
               zoom, radius_m, routing_mode
        FROM campus_settings
        WHERE id = 1
    """).fetchone()
    if not existing_settings:
        existing_settings = (
            DEFAULT_CAMPUS["id"], DEFAULT_CAMPUS["name"],
            DEFAULT_CAMPUS["short_name"], DEFAULT_CAMPUS["center_lat"],
            DEFAULT_CAMPUS["center_lng"], DEFAULT_CAMPUS["zoom"],
            DEFAULT_CAMPUS["radius_m"], DEFAULT_CAMPUS["routing_mode"],
        )
        conn.execute("""
            INSERT INTO campus_settings
            (id, campus_id, name, short_name, center_lat, center_lng,
             zoom, radius_m, routing_mode)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
        """, existing_settings)
    existing_campus = conn.execute(
        "SELECT id FROM campuses WHERE slug = ?",
        (existing_settings[0],),
    ).fetchone()
    if not existing_campus:
        conn.execute("""
            INSERT INTO campuses
            (slug, name, short_name, center_lat, center_lng, zoom, radius_m, routing_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, existing_settings)
        existing_campus = conn.execute(
            "SELECT id FROM campuses WHERE slug = ?",
            (existing_settings[0],),
        ).fetchone()
    conn.execute(
        "UPDATE locations SET campus_id = ? WHERE campus_id IS NULL",
        (existing_campus[0],),
    )
    conn.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS unique_location_per_campus
        ON locations(campus_id, name, building, floor)
    """)
    conn.commit()
    conn.close()


def campus_row(slug=None):
    conn = get_db_connection()
    if slug:
        row = conn.execute(
            "SELECT * FROM campuses WHERE slug = ?", (slug,)
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT * FROM campuses ORDER BY id LIMIT 1"
        ).fetchone()
    conn.close()
    return row


def public_campus(row):
    if not row:
        return dict(DEFAULT_CAMPUS)
    data = dict(row)
    data["id"] = data["slug"]
    data["owner_claimed"] = bool(data.get("owner_password_hash"))
    data.pop("owner_password_hash", None)
    return data


def get_campus_config(slug=None):
    row = campus_row(slug)
    if row:
        return public_campus(row)
    if slug in (None, DEFAULT_CAMPUS["slug"]):
        return dict(DEFAULT_CAMPUS)
    return None


def campus_id_for(slug):
    row = campus_row(slug)
    return row["id"] if row else None


def list_campuses():
    conn = get_db_connection()
    row = conn.execute("""
        SELECT slug, name, short_name, center_lat, center_lng, zoom,
               radius_m, routing_mode, owner_password_hash
        FROM campuses
        ORDER BY name COLLATE NOCASE
    """).fetchall()
    conn.close()
    return [public_campus(item) for item in row]


def campus_stats(campus_id=None):
    conn = get_db_connection()
    where = "WHERE campus_id = ?" if campus_id else ""
    args = (campus_id,) if campus_id else ()
    locations = conn.execute(
        f"SELECT COUNT(*) FROM locations {where}", args
    ).fetchone()[0]
    buildings = conn.execute("""
        SELECT COUNT(DISTINCT building)
        FROM locations
        WHERE building IS NOT NULL AND TRIM(building) != ''
          AND (? IS NULL OR campus_id = ?)
    """, (campus_id, campus_id)).fetchone()[0]
    conn.close()
    return {"locations": locations, "buildings": buildings}


def occupancy_location(campus_id, location_id):
    conn = get_db_connection()
    row = conn.execute(
        """
        SELECT id, name, building, floor
        FROM locations
        WHERE id = ? AND campus_id = ?
        """,
        (location_id, campus_id),
    ).fetchone()
    conn.close()
    return row


def insert_occupancy_observation(observation):
    record = observation.as_record()
    conn = sqlite3.connect("campus.db")
    try:
        cursor = conn.execute(
            """
            INSERT INTO occupancy_observations (
                campus_id, location_id, observed_at, observation_date,
                day_of_week, hour, minute, time_slot, total_capacity,
                occupied_count, available_count, occupancy_percentage,
                data_source, confidence
            ) VALUES (
                :campus_id, :location_id, :observed_at, :observation_date,
                :day_of_week, :hour, :minute, :time_slot, :total_capacity,
                :occupied_count, :available_count, :occupancy_percentage,
                :data_source, :confidence
            )
            """,
            record,
        )
        conn.commit()
        return cursor.lastrowid, record
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def insert_occupancy_records(records):
    conn = sqlite3.connect("campus.db")
    try:
        cursor = conn.executemany(
            """
            INSERT INTO occupancy_observations (
                campus_id, location_id, observed_at, observation_date,
                day_of_week, hour, minute, time_slot, total_capacity,
                occupied_count, available_count, occupancy_percentage,
                data_source, confidence
            ) VALUES (
                :campus_id, :location_id, :observed_at, :observation_date,
                :day_of_week, :hour, :minute, :time_slot, :total_capacity,
                :occupied_count, :available_count, :occupancy_percentage,
                :data_source, :confidence
            )
            """,
            records,
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return records


def occupancy_record(row):
    record = dict(row)
    record["location_id"] = int(record["location_id"])
    record["status"] = occupancy_status(record["occupancy_percentage"])
    return record


def occupancy_rows(
    campus_id,
    location_id=None,
    limit=100,
    start_at=None,
    end_at=None,
):
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT id, campus_id, location_id, observed_at, observation_date,
               day_of_week, hour, minute, time_slot, total_capacity,
               occupied_count, available_count, occupancy_percentage,
               data_source, confidence, created_at
        FROM occupancy_observations
        WHERE campus_id = ?
          AND (? IS NULL OR location_id = ?)
          AND (? IS NULL OR observed_at >= ?)
          AND (? IS NULL OR observed_at <= ?)
        ORDER BY observed_at DESC, id DESC
        LIMIT ?
        """,
        (
            campus_id,
            location_id,
            location_id,
            start_at,
            start_at,
            end_at,
            end_at,
            limit,
        ),
    ).fetchall()
    conn.close()
    return [occupancy_record(row) for row in rows]


def occupancy_facilities(campus_id, location_ids=None):
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT id, name, building, type
        FROM locations
        WHERE campus_id = ?
        ORDER BY id
        """,
        (campus_id,),
    ).fetchall()
    conn.close()
    selected = set(location_ids) if location_ids else None
    facilities = []
    for row in rows:
        if selected is not None and row["id"] not in selected:
            continue
        category = facility_category(row["name"], row["building"], row["type"])
        facilities.append({
            "id": row["id"],
            "name": row["name"],
            "building": row["building"],
            "category": category,
        })
    return facilities


def occupancy_capacity(value, category):
    if value is not None:
        try:
            capacity = int(value)
        except (TypeError, ValueError) as error:
            raise ValueError("capacity must be an integer") from error
        if capacity <= 0:
            raise ValueError("capacity must be greater than zero")
        return capacity
    return {
        "library": 200,
        "reading_room": 100,
        "lab": 60,
        "classroom": 80,
        "canteen": 250,
        "sports": 120,
        "default": 100,
    }[category]


def parse_range(value, field):
    if value is None:
        return None
    try:
        return parse_observed_at(value).isoformat(timespec="minutes")
    except ValueError as error:
        raise ValueError(f"{field} must be an ISO-8601 timestamp") from error


def featured_locations(campus_id=None):
    """Return a small generic list for the active campus home page."""
    conn = get_db_connection()
    rows = conn.execute("""
        SELECT name, building, floor
        FROM locations
        WHERE (? IS NULL OR campus_id = ?)
        ORDER BY name COLLATE NOCASE
        LIMIT 8
    """, (campus_id, campus_id)).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def _clean_text(value, max_length=240):
    return str(value or "").strip()[:max_length]


def _number(value, field, minimum, maximum):
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number")
    if not minimum <= number <= maximum:
        raise ValueError(f"{field} must be between {minimum} and {maximum}")
    return number


def save_campus_setup(payload, existing_slug=None):
    """Validate and create/update one campus and its places."""
    name = _clean_text(payload.get("name"), 120)
    if len(name) < 2:
        raise ValueError("College name is required")

    center_lat = _number(payload.get("center_lat"), "Campus latitude", -90, 90)
    center_lng = _number(payload.get("center_lng"), "Campus longitude", -180, 180)
    zoom = int(_number(payload.get("zoom", 17), "Map zoom", 10, 20))
    radius_m = _number(payload.get("radius_m", 1200), "Campus radius", 100, 100000)
    places = payload.get("locations") or []
    if not places:
        raise ValueError("Add at least one building or place")

    normalized_places = []
    seen = set()
    for index, place in enumerate(places, start=1):
        place_name = _clean_text(place.get("name"), 120)
        building = _clean_text(place.get("building"), 120)
        if not place_name or not building:
            raise ValueError(f"Place {index} needs a name and building")
        lat = _number(place.get("lat"), f"Place {index} latitude", -90, 90)
        lng = _number(place.get("lng"), f"Place {index} longitude", -180, 180)
        floor = _clean_text(place.get("floor"), 80) or "Ground"
        key = (place_name.casefold(), building.casefold(), floor.casefold())
        if key in seen:
            raise ValueError(f"Duplicate place: {place_name}")
        seen.add(key)
        normalized_places.append({
            "name": place_name,
            "building": building,
            "floor": floor,
            "lat": lat,
            "lng": lng,
            "type": _clean_text(place.get("type"), 40) or "general",
            "image": _clean_text(place.get("image"), 500),
            "instructions": _clean_text(place.get("instructions"), 500),
            "entry_lat": _number(
                place.get("entry_lat", lat), f"Place {index} entry latitude", -90, 90
            ),
            "entry_lng": _number(
                place.get("entry_lng", lng), f"Place {index} entry longitude", -180, 180
            ),
            "keywords": _clean_text(place.get("keywords"), 500),
        })

    slug = existing_slug or (
        re.sub(r"[^a-z0-9]+", "-", name.casefold()).strip("-")[:60] or "campus"
    )
    short_name = _clean_text(payload.get("short_name"), 80) or name
    owner_password = _clean_text(payload.get("owner_password"), 200)
    if not existing_slug and len(owner_password) < 8:
        raise ValueError("Choose an owner password with at least 8 characters")

    floor_plans = []
    for index, plan in enumerate(payload.get("floor_plans") or [], start=1):
        floor = _clean_text(plan.get("floor"), 80)
        title = _clean_text(plan.get("title"), 120) or f"{floor} floor plan"
        image_url = _clean_text(plan.get("image_url"), 1000)
        if not floor or not image_url:
            raise ValueError(f"Floor plan {index} needs a floor and image URL")
        floor_plans.append({
            "floor": floor,
            "title": title,
            "image_url": image_url,
            "width": _number(plan.get("width", 1000), f"Floor plan {index} width", 1, 10000),
            "height": _number(plan.get("height", 700), f"Floor plan {index} height", 1, 10000),
        })

    room_points = []
    for index, room in enumerate(payload.get("room_points") or [], start=1):
        room_name = _clean_text(room.get("name"), 120)
        room_building = _clean_text(room.get("building"), 120)
        room_floor = _clean_text(room.get("floor"), 80)
        if not room_name or not room_building or not room_floor:
            raise ValueError(f"Room {index} needs a name, building, and floor")
        room_points.append({
            "name": room_name,
            "building": room_building,
            "floor": room_floor,
            "x": _number(room.get("x"), f"Room {index} x position", 0, 100),
            "y": _number(room.get("y"), f"Room {index} y position", 0, 100),
            "keywords": _clean_text(room.get("keywords"), 500),
            "instructions": _clean_text(room.get("instructions"), 500),
        })

    conn = sqlite3.connect("campus.db")
    try:
        current = conn.execute(
            "SELECT id, owner_password_hash FROM campuses WHERE slug = ?",
            (slug,),
        ).fetchone()
        if existing_slug and not current:
            raise ValueError("Campus not found")
        if not existing_slug and current:
            raise ValueError("A campus with this name already exists")
        routing_mode = "vgu" if slug == DEFAULT_CAMPUS["slug"] else "generic"
        if current:
            campus_db_id = current[0]
            password_hash = (
                generate_password_hash(owner_password)
                if owner_password else current[1]
            )
            conn.execute("""
                UPDATE campuses
                SET name=?, short_name=?, center_lat=?, center_lng=?, zoom=?,
                    radius_m=?, routing_mode=?, owner_password_hash=?
                WHERE id=?
            """, (
                name, short_name, center_lat, center_lng, zoom, radius_m,
                routing_mode, password_hash, campus_db_id,
            ))
        else:
            password_hash = generate_password_hash(owner_password)
            cursor = conn.execute("""
                INSERT INTO campuses
                (slug, name, short_name, center_lat, center_lng, zoom, radius_m,
                 routing_mode, owner_password_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                slug, name, short_name, center_lat, center_lng, zoom, radius_m,
                routing_mode, password_hash,
            ))
            campus_db_id = cursor.lastrowid

        conn.execute("DELETE FROM locations WHERE campus_id = ?", (campus_db_id,))
        for place in normalized_places:
            conn.execute("""
                INSERT INTO locations
                (campus_id, name, building, floor, lat, lng, type, image,
                 instructions, entry_lat, entry_lng, keywords)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                campus_db_id,
                place["name"], place["building"], place["floor"],
                place["lat"], place["lng"], place["type"], place["image"],
                place["instructions"], place["entry_lat"], place["entry_lng"],
                place["keywords"],
            ))
        conn.execute("DELETE FROM floor_plans WHERE campus_id = ?", (campus_db_id,))
        for plan in floor_plans:
            conn.execute("""
                INSERT INTO floor_plans
                (campus_id, floor, title, image_url, width, height)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (
                campus_db_id, plan["floor"], plan["title"], plan["image_url"],
                plan["width"], plan["height"],
            ))
        conn.execute("DELETE FROM room_points WHERE campus_id = ?", (campus_db_id,))
        for room in room_points:
            conn.execute("""
                INSERT INTO room_points
                (campus_id, floor, name, building, x, y, keywords, instructions)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                campus_db_id, room["floor"], room["name"], room["building"],
                room["x"], room["y"], room["keywords"], room["instructions"],
            ))
        if slug == DEFAULT_CAMPUS["slug"]:
            conn.execute("""
                UPDATE campus_settings
                SET name=?, short_name=?, center_lat=?, center_lng=?, zoom=?,
                    radius_m=?, routing_mode=?
                WHERE id=1
            """, (
                name, short_name, center_lat, center_lng, zoom, radius_m,
                routing_mode,
            ))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return get_campus_config(slug)


ensure_schema()


def campus_context(slug):
    campus = get_campus_config(slug)
    if not campus:
        abort(404)
    return campus, campus_id_for(slug)


def admin_campus_ids():
    return {int(value) for value in session.get("admin_campus_ids", [])}


def is_campus_admin(campus_id):
    return campus_id in admin_campus_ids()


def grant_campus_admin(campus_id):
    ids = admin_campus_ids()
    ids.add(campus_id)
    session["admin_campus_ids"] = list(ids)
    session.modified = True


def floor_plan_payload(campus_id):
    conn = get_db_connection()
    plans = conn.execute("""
        SELECT floor, title, image_url, width, height
        FROM floor_plans
        WHERE campus_id = ?
        ORDER BY floor COLLATE NOCASE
    """, (campus_id,)).fetchall()
    rooms = conn.execute("""
        SELECT floor, name, building, x, y, keywords, instructions
        FROM room_points
        WHERE campus_id = ?
        ORDER BY floor COLLATE NOCASE, name COLLATE NOCASE
    """, (campus_id,)).fetchall()
    conn.close()
    return {
        "floor_plans": [dict(row) for row in plans],
        "room_points": [dict(row) for row in rooms],
    }


# ---------------- HOME ----------------
@app.route("/")
def home():
    return home_for(DEFAULT_CAMPUS["slug"])


@app.route("/c/<slug>")
def campus_home(slug):
    return home_for(slug)


def home_for(slug):
    campus, db_id = campus_context(slug)
    return render_template(
        "home.html",
        campus=campus,
        stats=campus_stats(db_id),
        featured_locations=featured_locations(db_id),
        campuses=list_campuses(),
    )


# ---------------- DIRECTIONS PAGE ----------------
@app.route("/directions")
def directions():
    return directions_for(DEFAULT_CAMPUS["slug"])


@app.route("/c/<slug>/directions")
def campus_directions(slug):
    return directions_for(slug)


def directions_for(slug):
    campus, db_id = campus_context(slug)
    query = request.args.get("q", "").strip()

    if not query:
        return render_template(
            "results.html", location=None, query=query, campus=campus
        )

    locations = find_locations(query, limit=1, campus_id=db_id)
    location = locations[0] if locations else None
    if location:
        location["panorama_url"] = panorama_for_location(location["name"], slug)
    return render_template(
        "results.html", location=location, query=query, campus=campus
    )


# ---------------- MAP PAGE ----------------
@app.route("/map")
def map_page():
    return map_for(DEFAULT_CAMPUS["slug"])


@app.route("/c/<slug>/map")
def campus_map(slug):
    return map_for(slug)


def map_for(slug):
    campus, _ = campus_context(slug)
    # Support both links generated by the app and manual URLs such as /map?q=Library.
    destination = request.args.get("destination") or request.args.get("q", "")
    return render_template(
        "map.html", destination=destination, campus=campus
    )


# ---------------- SEARCH (JSON) ----------------
@app.route("/search")
def search_location():
    return search_for(request.args.get("campus", DEFAULT_CAMPUS["slug"]))


@app.route("/c/<slug>/search")
def campus_search(slug):
    return search_for(slug)


def search_for(slug):
    campus, db_id = campus_context(slug)
    query = request.args.get("q", "").strip()

    locations = find_locations(query, limit=1, campus_id=db_id)
    if locations:
        location = locations[0]
        location.pop("keywords", None)
        location["panorama_url"] = panorama_for_location(location["name"], slug)
        return jsonify(location)
    return jsonify({})


# ---------------- 360° INDOOR VIEWER ----------------
@app.route("/panorama/<scene_id>")
def panorama(scene_id):
    return campus_panorama(DEFAULT_CAMPUS["slug"], scene_id)


@app.route("/c/<slug>/panorama/<scene_id>")
def campus_panorama(slug, scene_id):
    campus, _ = campus_context(slug)
    scene = PANORAMA_SCENES.get(scene_id)
    if not scene or campus["routing_mode"] != "vgu":
        abort(404)
    return render_template(
        "panorama.html",
        scene=scene,
        campus=campus,
        back_url=url_for("campus_directions", slug=slug, q=scene["title"]),
    )


# ---------------- CAMPUS SETUP AND ACCESS ----------------
@app.route("/setup")
def setup_page():
    return render_template(
        "setup.html",
        campus=None,
        campuses=list_campuses(),
        mode="create",
        floor_data={"floor_plans": [], "room_points": []},
    )


@app.route("/api/campuses", methods=["GET", "POST"])
def campuses_api():
    if request.method == "GET":
        return jsonify(list_campuses())
    payload = request.get_json(silent=True) or {}
    try:
        campus = save_campus_setup(payload)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    campus_db_id = campus_id_for(campus["slug"])
    grant_campus_admin(campus_db_id)
    return jsonify({
        "campus": campus,
        "stats": campus_stats(campus_db_id),
        "url": url_for("campus_home", slug=campus["slug"]),
        "message": f"{campus['name']} was created",
    }), 201


@app.route("/api/campus", methods=["GET", "POST"])
def campus_api():
    """Compatibility endpoint for the original default-campus API."""
    if request.method == "GET":
        campus, db_id = campus_context(DEFAULT_CAMPUS["slug"])
        return jsonify({
            **campus,
            "stats": campus_stats(db_id),
            **floor_plan_payload(db_id),
        })
    payload = request.get_json(silent=True) or {}
    try:
        campus = save_campus_setup(payload)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    campus_db_id = campus_id_for(campus["slug"])
    grant_campus_admin(campus_db_id)
    return jsonify({
        "campus": campus,
        "stats": campus_stats(campus_db_id),
        "message": f"{campus['name']} was created",
    }), 201


@app.route("/api/campus/<slug>", methods=["GET", "PUT"])
def campus_detail_api(slug):
    campus, db_id = campus_context(slug)
    if request.method == "GET":
        return jsonify({
            **campus,
            "stats": campus_stats(db_id),
            **floor_plan_payload(db_id),
        })
    if not is_campus_admin(db_id):
        return jsonify({"error": "Owner access required"}), 403
    payload = request.get_json(silent=True) or {}
    try:
        updated = save_campus_setup(payload, existing_slug=slug)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({
        "campus": updated,
        "stats": campus_stats(db_id),
        "message": f"{updated['name']} was updated",
    })


@app.route("/c/<slug>/admin")
def campus_admin(slug):
    campus, db_id = campus_context(slug)
    if is_campus_admin(db_id):
        return render_template(
            "setup.html",
            campus=campus,
            campuses=list_campuses(),
            mode="edit",
            floor_data=floor_plan_payload(db_id),
        )
    if not campus["owner_claimed"]:
        return render_template("claim.html", campus=campus)
    return render_template("admin-login.html", campus=campus)


@app.route("/c/<slug>/admin/login", methods=["POST"])
def campus_admin_login(slug):
    campus, db_id = campus_context(slug)
    password = request.form.get("password", "")
    row = campus_row(slug)
    if row and row["owner_password_hash"] and check_password_hash(
        row["owner_password_hash"], password
    ):
        grant_campus_admin(db_id)
        return redirect(url_for("campus_admin", slug=slug))
    return render_template(
        "admin-login.html", campus=campus, error="Incorrect owner password."
    ), 401


@app.route("/c/<slug>/claim", methods=["POST"])
def claim_campus(slug):
    campus, db_id = campus_context(slug)
    row = campus_row(slug)
    if row["owner_password_hash"]:
        return redirect(url_for("campus_admin", slug=slug))
    password = request.form.get("password", "")
    if len(password) < 8:
        return render_template(
            "claim.html", campus=campus,
            error="Choose a password with at least 8 characters."
        ), 400
    conn = sqlite3.connect("campus.db")
    conn.execute(
        "UPDATE campuses SET owner_password_hash=? WHERE id=? AND owner_password_hash IS NULL",
        (generate_password_hash(password), db_id),
    )
    conn.commit()
    conn.close()
    grant_campus_admin(db_id)
    return redirect(url_for("campus_admin", slug=slug))


@app.route("/c/<slug>/admin/logout")
def campus_admin_logout(slug):
    campus, db_id = campus_context(slug)
    ids = admin_campus_ids()
    ids.discard(db_id)
    session["admin_campus_ids"] = list(ids)
    return redirect(url_for("campus_home", slug=slug))


@app.route("/c/<slug>/floorplan")
def campus_floorplan(slug):
    campus, db_id = campus_context(slug)
    data = floor_plan_payload(db_id)
    requested_floor = request.args.get("floor", "").strip()
    plans = data["floor_plans"]
    plan = next((item for item in plans if item["floor"] == requested_floor), None)
    if not plan and plans:
        plan = plans[0]
    rooms = [item for item in data["room_points"]
             if not plan or item["floor"] == plan["floor"]]
    return render_template(
        "floorplan.html", campus=campus, plan=plan, rooms=rooms, plans=plans
    )


# ---------------- SUGGEST ----------------
@app.route("/suggest")
def suggest():
    slug = request.args.get("campus", DEFAULT_CAMPUS["slug"])
    _, db_id = campus_context(slug)
    query = request.args.get("q", "").strip()
    return jsonify([
        location["name"]
        for location in find_locations(query, limit=8, campus_id=db_id)
    ])


# ---------------- SYNC JSON → DB ----------------
def sync_json_to_db():
    conn = sqlite3.connect("campus.db")
    cursor = conn.cursor()
    vgu_id = cursor.execute(
        "SELECT id FROM campuses WHERE slug = ?", (DEFAULT_CAMPUS["slug"],)
    ).fetchone()[0]

    with open("data/locations.json", "r") as file:
        data = json.load(file)

    cursor.execute("DELETE FROM locations WHERE campus_id = ?", (vgu_id,))
    for loc in data:
        cursor.execute("""
        INSERT INTO locations
        (campus_id, name, building, floor, lat, lng, type, image, instructions,
         entry_lat, entry_lng, keywords)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            vgu_id,
            loc.get("name"),
            loc.get("building"),
            loc.get("floor"),
            loc.get("lat"),
            loc.get("lng"),
            loc.get("type", "general"),
            loc.get("image", ""),
            loc.get("instructions", ""),
            loc.get("entry_lat", loc.get("lat")),
            loc.get("entry_lng", loc.get("lng")),
            loc.get("keywords", ""),
        ))

    cursor.execute("""
        UPDATE campuses
        SET name=?, short_name=?, center_lat=?, center_lng=?, zoom=?,
            radius_m=?, routing_mode=?
        WHERE id=?
    """, (
        DEFAULT_CAMPUS["name"], DEFAULT_CAMPUS["short_name"],
        DEFAULT_CAMPUS["center_lat"], DEFAULT_CAMPUS["center_lng"],
        DEFAULT_CAMPUS["zoom"], DEFAULT_CAMPUS["radius_m"],
        DEFAULT_CAMPUS["routing_mode"], vgu_id,
    ))
    cursor.execute("""
        UPDATE campus_settings
        SET campus_id = ?, name = ?, short_name = ?, center_lat = ?,
            center_lng = ?, zoom = ?, radius_m = ?, routing_mode = ?
        WHERE id = 1
    """, (
        DEFAULT_CAMPUS["id"],
        DEFAULT_CAMPUS["name"],
        DEFAULT_CAMPUS["short_name"],
        DEFAULT_CAMPUS["center_lat"],
        DEFAULT_CAMPUS["center_lng"],
        DEFAULT_CAMPUS["zoom"],
        DEFAULT_CAMPUS["radius_m"],
        DEFAULT_CAMPUS["routing_mode"],
    ))
    conn.commit()
    conn.close()
    print("JSON synced to DB")


# ---------------- NEARBY PAGE ----------------
@app.route("/nearby")
def nearby():
    return nearby_for(DEFAULT_CAMPUS["slug"])


@app.route("/c/<slug>/nearby")
def campus_nearby(slug):
    return nearby_for(slug)


def nearby_for(slug):
    campus, _ = campus_context(slug)
    return render_template("nearby.html", campus=campus)


# ---------------- ALL LOCATIONS API ----------------
@app.route("/api/locations")
def all_locations():
    slug = request.args.get("campus", DEFAULT_CAMPUS["slug"])
    _, db_id = campus_context(slug)
    conn = get_db_connection()
    rows = conn.execute(
        """SELECT name, building, floor, lat, lng, type, image, instructions,
                  entry_lat, entry_lng, keywords
           FROM locations
           WHERE campus_id = ?""",
        (db_id,),
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ---------------- OCCUPANCY API ----------------
def occupancy_api_location_id(payload):
    try:
        return int(payload.get("location_id"))
    except (TypeError, ValueError) as error:
        raise ValueError("location_id must be an integer") from error


def occupancy_response(observation_id, record):
    record = dict(record)
    record["status"] = occupancy_status(record["occupancy_percentage"])
    return {
        "observation": {
            "id": observation_id,
            **record,
        },
        "data_status": (
            "synthetic development data"
            if record["data_source"] == "DEMO_SYNTHETIC"
            else "observed data"
        ),
    }


@app.route("/api/c/<slug>/occupancy/locations")
def occupancy_locations(slug):
    _, campus_db_id = campus_context(slug)
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT id, name, building, floor
        FROM locations
        WHERE campus_id = ?
        ORDER BY name COLLATE NOCASE, building COLLATE NOCASE
        """,
        (campus_db_id,),
    ).fetchall()
    conn.close()
    return jsonify([dict(row) for row in rows])


@app.route("/api/c/<slug>/occupancy", methods=["GET", "POST"])
def campus_occupancy(slug):
    _, campus_db_id = campus_context(slug)
    if request.method == "GET":
        location_id = request.args.get("location_id")
        if location_id is not None:
            try:
                location_id = int(location_id)
            except ValueError as error:
                return jsonify({"error": "location_id must be an integer"}), 400
            if not occupancy_location(campus_db_id, location_id):
                return jsonify({"error": "Location not found for this campus"}), 404
        try:
            limit = max(1, min(int(request.args.get("limit", 100)), 500))
            start_at = parse_range(request.args.get("start"), "start")
            end_at = parse_range(request.args.get("end"), "end")
            if start_at and end_at and start_at > end_at:
                raise ValueError("start must be before or equal to end")
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        return jsonify({
            "data_status": "observed and synthetic records are labeled by data_source",
            "observations": occupancy_rows(
                campus_db_id, location_id, limit, start_at, end_at
            ),
        })

    payload = request.get_json(silent=True) or {}
    try:
        location_id = occupancy_api_location_id(payload)
        if not occupancy_location(campus_db_id, location_id):
            return jsonify({"error": "Location not found for this campus"}), 404
        source = ManualOccupancySource()
        observation = source.observe(
            campus_db_id,
            location_id,
            payload.get("capacity"),
            payload.get("occupied"),
            confidence=payload.get("confidence"),
            observed_at=payload.get("observed_at"),
        )
        observation_id, record = insert_occupancy_observation(observation)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(occupancy_response(observation_id, record)), 201


@app.route("/api/c/<slug>/occupancy/demo/generate", methods=["POST"])
def generate_demo_occupancy(slug):
    _, campus_db_id = campus_context(slug)
    payload = request.get_json(silent=True) or {}
    try:
        days = int(payload.get("days", 7))
        if days < 1 or days > 180:
            raise ValueError("days must be between 1 and 180")
        interval_minutes = int(payload.get("interval_minutes", 60))
        if interval_minutes < 5 or interval_minutes > 1440:
            raise ValueError("interval_minutes must be between 5 and 1440")
        end_at = parse_observed_at(payload.get("end_at"))
        start_at = parse_observed_at(
            payload.get("start_at")
        ) if payload.get("start_at") else end_at - timedelta(days=days)
        if start_at >= end_at:
            raise ValueError("start_at must be before end_at")
        location_ids = payload.get("location_ids")
        if location_ids is not None:
            try:
                location_ids = [int(value) for value in location_ids]
            except (TypeError, ValueError) as error:
                raise ValueError("location_ids must be an array of integers") from error
        facilities = occupancy_facilities(campus_db_id, location_ids)
        if not facilities:
            raise ValueError("No locations found for this campus")
        capacities = payload.get("capacities") or {}
        for facility in facilities:
            facility["capacity"] = occupancy_capacity(
                capacities.get(str(facility["id"]), capacities.get(facility["id"])),
                facility["category"],
            )
        slots = int((end_at - start_at).total_seconds() // (interval_minutes * 60)) + 1
        expected_records = slots * len(facilities)
        if expected_records > 100000:
            raise ValueError(
                "Requested dataset is too large; reduce days, interval, or locations"
            )
        source = DemoOccupancySource(seed=payload.get("seed"))
        records = [
            observation.as_record()
            for observation in source.generate(
                campus_db_id,
                facilities,
                start_at,
                end_at,
                interval_minutes,
            )
        ]
        insert_occupancy_records(records)
        inserted = len(records)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({
        "data_status": "synthetic development data",
        "generated": inserted,
        "start_at": start_at.isoformat(timespec="minutes"),
        "end_at": end_at.isoformat(timespec="minutes"),
        "interval_minutes": interval_minutes,
        "locations": len(facilities),
    }), 201


@app.route("/api/c/<slug>/occupancy/demo", methods=["POST"])
def campus_demo_occupancy(slug):
    _, campus_db_id = campus_context(slug)
    payload = request.get_json(silent=True) or {}
    try:
        location_id = occupancy_api_location_id(payload)
        if not occupancy_location(campus_db_id, location_id):
            return jsonify({"error": "Location not found for this campus"}), 404
        source = DemoOccupancySource()
        observation = source.observe(
            campus_db_id,
            location_id,
            payload.get("capacity"),
            occupied=payload.get("occupied"),
            observed_at=payload.get("observed_at"),
        )
        observation_id, record = insert_occupancy_observation(observation)
    except (ValueError, sqlite3.IntegrityError) as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(occupancy_response(observation_id, record)), 201


@app.route("/api/c/<slug>/occupancy/current")
def campus_current_occupancy(slug):
    _, campus_db_id = campus_context(slug)
    location_id = request.args.get("location_id")
    if location_id is not None:
        try:
            location_id = int(location_id)
        except ValueError as error:
            return jsonify({"error": "location_id must be an integer"}), 400
        if not occupancy_location(campus_db_id, location_id):
            return jsonify({"error": "Location not found for this campus"}), 404

    records = occupancy_rows(campus_db_id, location_id, 500)
    latest = {}
    for record in records:
        latest.setdefault(record["location_id"], record)
    return jsonify({
        "data_status": "latest available observations; not predictions",
        "observations": list(latest.values()),
    })


@app.route("/api/c/<slug>/occupancy/summary")
def campus_occupancy_summary(slug):
    _, campus_db_id = campus_context(slug)
    try:
        start_at = parse_range(request.args.get("start"), "start")
        end_at = parse_range(request.args.get("end"), "end")
        if start_at and end_at and start_at > end_at:
            raise ValueError("start must be before or equal to end")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    conn = get_db_connection()
    filters = ["campus_id = ?"]
    args = [campus_db_id]
    if start_at:
        filters.append("observed_at >= ?")
        args.append(start_at)
    if end_at:
        filters.append("observed_at <= ?")
        args.append(end_at)
    where = " AND ".join(filters)
    overall = conn.execute(
        f"""
        SELECT COUNT(*) AS total_observations,
               MIN(observed_at) AS earliest_observation,
               MAX(observed_at) AS latest_observation,
               AVG(occupancy_percentage) AS average_occupancy,
               MAX(occupancy_percentage) AS maximum_occupancy,
               MIN(occupancy_percentage) AS minimum_occupancy
        FROM occupancy_observations
        WHERE {where}
        """,
        args,
    ).fetchone()
    by_facility = conn.execute(
        f"""
        SELECT o.location_id, l.name, l.building,
               COUNT(*) AS observations,
               AVG(o.occupancy_percentage) AS average_occupancy,
               MAX(o.occupancy_percentage) AS maximum_occupancy,
               MIN(o.occupancy_percentage) AS minimum_occupancy
        FROM occupancy_observations AS o
        JOIN locations AS l ON l.id = o.location_id AND l.campus_id = o.campus_id
        WHERE {where}
        GROUP BY o.location_id, l.name, l.building
        ORDER BY l.name COLLATE NOCASE
        """,
        args,
    ).fetchall()
    conn.close()
    result = dict(overall)
    for key in (
        "average_occupancy",
        "maximum_occupancy",
        "minimum_occupancy",
    ):
        if result[key] is not None:
            result[key] = round(result[key], 2)
    result["total_observations"] = result["total_observations"] or 0
    result["by_campus"] = [{
        "campus_id": campus_db_id,
        "observations": result["total_observations"],
    }]
    result["by_facility"] = []
    for row in by_facility:
        item = dict(row)
        for key in ("average_occupancy", "maximum_occupancy", "minimum_occupancy"):
            item[key] = round(item[key], 2)
        result["by_facility"].append(item)
    return jsonify(result)


@app.route("/api/occupancy/summary")
def occupancy_summary():
    campus_slug = request.args.get("campus")
    campus_id = None
    if campus_slug:
        campus_id = campus_id_for(campus_slug)
        if campus_id is None:
            return jsonify({"error": "Campus not found"}), 404
    try:
        start_at = parse_range(request.args.get("start"), "start")
        end_at = parse_range(request.args.get("end"), "end")
        if start_at and end_at and start_at > end_at:
            raise ValueError("start must be before or equal to end")
    except ValueError as error:
        return jsonify({"error": str(error)}), 400

    filters = ["1 = 1"]
    args = []
    if campus_id is not None:
        filters.append("o.campus_id = ?")
        args.append(campus_id)
    if start_at:
        filters.append("o.observed_at >= ?")
        args.append(start_at)
    if end_at:
        filters.append("o.observed_at <= ?")
        args.append(end_at)
    where = " AND ".join(filters)
    conn = get_db_connection()
    overall = conn.execute(
        f"""
        SELECT COUNT(*) AS total_observations,
               MIN(o.observed_at) AS earliest_observation,
               MAX(o.observed_at) AS latest_observation,
               AVG(o.occupancy_percentage) AS average_occupancy,
               MAX(o.occupancy_percentage) AS maximum_occupancy,
               MIN(o.occupancy_percentage) AS minimum_occupancy
        FROM occupancy_observations AS o
        WHERE {where}
        """,
        args,
    ).fetchone()
    campus_rows = conn.execute(
        f"""
        SELECT o.campus_id, c.slug, c.name, COUNT(*) AS observations
        FROM occupancy_observations AS o
        JOIN campuses AS c ON c.id = o.campus_id
        WHERE {where}
        GROUP BY o.campus_id, c.slug, c.name
        ORDER BY c.name COLLATE NOCASE
        """,
        args,
    ).fetchall()
    facility_rows = conn.execute(
        f"""
        SELECT o.campus_id, o.location_id, l.name, l.building,
               COUNT(*) AS observations,
               AVG(o.occupancy_percentage) AS average_occupancy,
               MAX(o.occupancy_percentage) AS maximum_occupancy,
               MIN(o.occupancy_percentage) AS minimum_occupancy
        FROM occupancy_observations AS o
        JOIN locations AS l ON l.id = o.location_id AND l.campus_id = o.campus_id
        WHERE {where}
        GROUP BY o.campus_id, o.location_id, l.name, l.building
        ORDER BY l.name COLLATE NOCASE
        """,
        args,
    ).fetchall()
    conn.close()

    result = dict(overall)
    result["total_observations"] = result["total_observations"] or 0
    for key in ("average_occupancy", "maximum_occupancy", "minimum_occupancy"):
        if result[key] is not None:
            result[key] = round(result[key], 2)
    result["by_campus"] = [dict(row) for row in campus_rows]
    result["by_facility"] = []
    for row in facility_rows:
        item = dict(row)
        for key in ("average_occupancy", "maximum_occupancy", "minimum_occupancy"):
            item[key] = round(item[key], 2)
        result["by_facility"].append(item)
    return jsonify(result)


# ---------------- OCCUPANCY ML API ----------------
def prediction_service_for(campus_id):
    service = prediction_services.get(campus_id)
    if service is None:
        service = PredictionService(
            registry=ModelRegistry("models"),
            minimum_observations=10,
        )
        prediction_services[campus_id] = service
    return service


def prediction_location(campus_id, location_id):
    conn = get_db_connection()
    row = conn.execute(
        """
        SELECT l.id, l.name, l.building, l.type,
               o.total_capacity
        FROM locations AS l
        LEFT JOIN occupancy_observations AS o
          ON o.location_id = l.id AND o.campus_id = l.campus_id
        WHERE l.id = ? AND l.campus_id = ?
        ORDER BY o.observed_at DESC
        LIMIT 1
        """,
        (location_id, campus_id),
    ).fetchone()
    conn.close()
    return row


def prediction_input(campus_id, location_id, timestamp, capacity):
    return {
        "campus_id": campus_id,
        "location_id": location_id,
        "observed_at": timestamp.isoformat(timespec="minutes"),
        "total_capacity": capacity,
    }


@app.route("/api/c/<slug>/occupancy/train", methods=["POST"])
def train_occupancy_model(slug):
    _, campus_db_id = campus_context(slug)
    payload = request.get_json(silent=True) or {}
    location_id = payload.get("location_id")
    try:
        location_id = int(location_id) if location_id is not None else None
    except (TypeError, ValueError):
        return jsonify({"error": "location_id must be an integer"}), 400
    if location_id is not None and not occupancy_location(campus_db_id, location_id):
        return jsonify({"error": "Location not found for this campus"}), 404
    service = prediction_service_for(campus_db_id)
    observations = service.load_observations(
        "campus.db", campus_db_id, location_id
    )
    try:
        metadata = service.train(observations)
    except InsufficientDataError as error:
        return jsonify({
            "error": "Insufficient historical data for reliable model evaluation.",
            "detail": str(error),
            "observations": len(observations),
        }), 400
    prediction_metadata[campus_db_id] = metadata
    return jsonify({
        "status": "trained",
        "data_status": (
            "synthetic development data"
            if any(row["data_source"] == "DEMO_SYNTHETIC" for row in observations)
            else "observed data"
        ),
        "metadata": metadata,
    }), 201


@app.route("/api/c/<slug>/occupancy/retrain", methods=["POST"])
def retrain_occupancy_model(slug):
    _, campus_db_id = campus_context(slug)
    payload = request.get_json(silent=True) or {}
    try:
        threshold = int(payload.get("minimum_new_observations", 10))
    except (TypeError, ValueError):
        return jsonify({"error": "minimum_new_observations must be an integer"}), 400
    service = prediction_service_for(campus_db_id)
    observations = service.load_observations("campus.db", campus_db_id)
    if len(observations) < threshold:
        return jsonify({
            "error": "Retraining threshold has not been reached.",
            "observations": len(observations),
            "threshold": threshold,
        }), 400
    candidate = PredictionService(
        registry=ModelRegistry("models"),
        minimum_observations=service.minimum_observations,
    )
    try:
        metadata = candidate.train(observations)
    except InsufficientDataError as error:
        return jsonify({
            "error": "Insufficient historical data for reliable model evaluation.",
            "detail": str(error),
        }), 400
    previous = prediction_metadata.get(campus_db_id)
    previous_mae = (
        previous.get("test_metrics", {}).get("mae") if previous else None
    )
    candidate_mae = metadata.get("test_metrics", {}).get("mae")
    if previous_mae is not None and candidate_mae >= previous_mae:
        return jsonify({
            "status": "kept_previous_model",
            "candidate_metrics": metadata.get("test_metrics"),
            "previous_metrics": previous.get("test_metrics"),
        })
    prediction_services[campus_db_id] = candidate
    prediction_metadata[campus_db_id] = metadata
    return jsonify({"status": "promoted", "metadata": metadata}), 201


@app.route("/api/c/<slug>/occupancy/predict")
def predict_occupancy(slug):
    _, campus_db_id = campus_context(slug)
    try:
        location_id = int(request.args["location_id"])
        timestamp = parse_observed_at(request.args["at"])
    except (KeyError, TypeError, ValueError) as error:
        return jsonify({
            "error": "location_id and at (ISO-8601 timestamp) are required"
        }), 400
    location = prediction_location(campus_db_id, location_id)
    if not location:
        return jsonify({"error": "Location not found for this campus"}), 404
    if location["total_capacity"] is None:
        return jsonify({"error": "Train a model after recording capacity"}), 400
    service = prediction_services.get(campus_db_id)
    if service is None or service.model is None:
        return jsonify({
            "error": "No trained model is available for this campus"
        }), 400
    row = prediction_input(
        campus_db_id, location_id, timestamp, location["total_capacity"]
    )
    percentage = service.predict_one(row)
    occupied = round(location["total_capacity"] * percentage / 100)
    prediction_record = {
        **row,
        "predicted_percentage": round(percentage, 2),
    }
    prediction_connection = sqlite3.connect("campus.db")
    try:
        store_prediction(
            prediction_connection,
            service.model_name,
            prediction_record,
        )
    finally:
        prediction_connection.close()
    return jsonify({
        "data_status": "predicted from historical observations",
        "prediction": {
            "campus_id": campus_db_id,
            "location_id": location_id,
            "location_name": location["name"],
            "predicted_for": row["observed_at"],
            "predicted_occupancy": occupied,
            "predicted_occupancy_percentage": round(percentage, 2),
            "estimated_available": location["total_capacity"] - occupied,
            "capacity": location["total_capacity"],
            "status": occupancy_status(percentage),
            "model": service.model_name,
            "model_metadata": prediction_metadata.get(campus_db_id),
        },
    })


@app.route("/api/c/<slug>/occupancy/best-times")
def occupancy_best_times(slug):
    _, campus_db_id = campus_context(slug)
    try:
        location_id = int(request.args["location_id"])
        start_at = parse_observed_at(request.args["start"])
        end_at = parse_observed_at(request.args["end"])
        interval = int(request.args.get("interval_minutes", 60))
        if end_at <= start_at or interval <= 0:
            raise ValueError
    except (KeyError, TypeError, ValueError):
        return jsonify({
            "error": "location_id, start, end, and a positive interval are required"
        }), 400
    location = prediction_location(campus_db_id, location_id)
    service = prediction_services.get(campus_db_id)
    if not location:
        return jsonify({"error": "Location not found for this campus"}), 404
    if service is None or service.model is None:
        return jsonify({
            "error": "Insufficient historical data for a recommendation"
        }), 400
    results = []
    cursor = start_at
    while cursor <= end_at:
        row = prediction_input(
            campus_db_id, location_id, cursor, location["total_capacity"]
        )
        percentage = service.predict_one(row)
        results.append({
            "at": row["observed_at"],
            "predicted_occupancy_percentage": round(percentage, 2),
            "estimated_available": round(
                location["total_capacity"] * (1 - percentage / 100)
            ),
        })
        cursor += timedelta(minutes=interval)
    results.sort(key=lambda item: item["predicted_occupancy_percentage"])
    return jsonify({
        "data_status": "predicted from historical observations",
        "recommendations": results[:3],
        "model": service.model_name,
    })


@app.route("/c/<slug>/intelligence")
def campus_intelligence(slug):
    campus, campus_db_id = campus_context(slug)
    conn = get_db_connection()
    rows = conn.execute(
        """
        SELECT o.location_id, l.name AS location_name,
               o.total_capacity, o.occupied_count, o.available_count,
               o.occupancy_percentage, o.data_source
        FROM occupancy_observations AS o
        JOIN locations AS l ON l.id = o.location_id AND l.campus_id = o.campus_id
        WHERE o.campus_id = ?
          AND o.id = (
            SELECT latest.id
            FROM occupancy_observations AS latest
            WHERE latest.campus_id = o.campus_id
              AND latest.location_id = o.location_id
            ORDER BY latest.observed_at DESC, latest.id DESC
            LIMIT 1
          )
        ORDER BY l.name COLLATE NOCASE
        """,
        (campus_db_id,),
    ).fetchall()
    current = []
    for row in rows:
        item = dict(row)
        item["status"] = occupancy_status(item["occupancy_percentage"])
        current.append(item)
    conn.close()
    summary = {
        "total_observations": 0,
        "average_occupancy": None,
        "minimum_occupancy": None,
        "maximum_occupancy": None,
    }
    summary_rows = occupancy_rows(campus_db_id, limit=500)
    if summary_rows:
        percentages = [item["occupancy_percentage"] for item in summary_rows]
        summary.update({
            "total_observations": len(summary_rows),
            "average_occupancy": round(sum(percentages) / len(percentages), 2),
            "minimum_occupancy": min(percentages),
            "maximum_occupancy": max(percentages),
        })
    return render_template(
        "intelligence.html",
        campus=campus,
        current=current,
        summary=summary,
    )


# ---------------- SYNC ROUTE ----------------
@app.route("/sync")
def sync():
    vgu_id = campus_id_for(DEFAULT_CAMPUS["slug"])
    if not is_campus_admin(vgu_id):
        return jsonify({"error": "Owner access required"}), 403
    sync_json_to_db()
    return jsonify({
        "campus": get_campus_config(),
        "stats": campus_stats(vgu_id),
        "message": "VGU data synchronized successfully",
    })


# ---------------- RUN ----------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
