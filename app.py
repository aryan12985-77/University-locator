from flask import Flask, render_template, request, jsonify, make_response
import sqlite3
import json

app = Flask(__name__)


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
    conn = sqlite3.connect("campus.db")
    conn.row_factory = sqlite3.Row
    return conn


# ---------------- HOME ----------------
@app.route("/")
def home():
    return render_template("home.html")


# ---------------- DIRECTIONS PAGE ----------------
@app.route("/directions")
def directions():
    query = request.args.get("q", "").strip()

    if not query:
        return render_template("results.html", location=None, query=query)

    conn = get_db_connection()
    row = conn.execute("""
        SELECT name, building, floor, lat, lng,
               image, instructions, entry_lat, entry_lng
        FROM locations
        WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(keywords) LIKE '%' || LOWER(?) || '%'
           OR LOWER(building) LIKE '%' || LOWER(?) || '%'
        LIMIT 1
    """, (query, query, query)).fetchone()
    conn.close()

    location = dict(row) if row else None
    return render_template("results.html", location=location, query=query)


# ---------------- MAP PAGE ----------------
@app.route("/map")
def map_page():
    destination = request.args.get("destination", "")
    return render_template("map.html", destination=destination)


# ---------------- SEARCH (JSON) ----------------
@app.route("/search")
def search_location():
    query = request.args.get("q", "").strip()

    conn = get_db_connection()
    row = conn.execute("""
        SELECT name, building, floor, lat, lng,
               image, instructions, entry_lat, entry_lng
        FROM locations
        WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(keywords) LIKE '%' || LOWER(?) || '%'
           OR LOWER(building) LIKE '%' || LOWER(?) || '%'
        LIMIT 1
    """, (query, query, query)).fetchone()
    conn.close()

    if row:
        return jsonify(dict(row))
    return jsonify({})


# ---------------- SUGGEST ----------------
@app.route("/suggest")
def suggest():
    query = request.args.get("q", "").strip()

    conn = get_db_connection()
    rows = conn.execute("""
        SELECT name FROM locations
        WHERE LOWER(name) LIKE '%' || LOWER(?) || '%'
           OR LOWER(keywords) LIKE '%' || LOWER(?) || '%'
           OR LOWER(building) LIKE '%' || LOWER(?) || '%'
        LIMIT 8
    """, (query, query, query)).fetchall()
    conn.close()

    return jsonify([row["name"] for row in rows])


# ---------------- SYNC JSON → DB ----------------
def sync_json_to_db():
    conn = sqlite3.connect("campus.db")
    cursor = conn.cursor()

    with open("data/locations.json", "r") as file:
        data = json.load(file)

    for loc in data:
        cursor.execute("""
        INSERT OR REPLACE INTO locations
        (name, building, floor, lat, lng, type, image, instructions, entry_lat, entry_lng, keywords)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
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

    conn.commit()
    conn.close()
    print("JSON synced to DB")


# ---------------- NEARBY PAGE ----------------
@app.route("/nearby")
def nearby():
    return render_template("nearby.html")


# ---------------- ALL LOCATIONS API ----------------
@app.route("/api/locations")
def all_locations():
    conn = get_db_connection()
    rows = conn.execute(
        "SELECT name, building, floor, lat, lng, type, instructions FROM locations"
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


# ---------------- SYNC ROUTE ----------------
@app.route("/sync")
def sync():
    sync_json_to_db()
    return "Data synchronized successfully!"


# ---------------- RUN ----------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False, use_reloader=False)
