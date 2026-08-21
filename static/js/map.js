/* ============================================================
   Campus Navigator — Full Page Map  |  VGU, Jaipur
   Maintenance guide:
   - Change CAMPUS_LAT/LNG/ZOOM to adjust the default map view.
   - Change mkUserIcon() to redesign the live person marker.
   - GPS updates and travel direction arrive in onLocationFound().
   - Map controls are created in initMapControls().
   ============================================================ */

/* Campus centre (used as fallback view) */
var CAMPUS_LAT  = 26.8123;
var CAMPUS_LNG  = 75.8935;
var CAMPUS_ZOOM = 18;

var map             = null;
var userMarker      = null;
var destMarker      = null;
var routeLine       = null;
var destinationData = null;
var locating        = false;
// Direction is deliberately based on movement/course, not phone tilt or hand angle.
var movementHeading = null;
var lastPosition    = null;
var satelliteLayer  = null;
var streetLayer     = null;
var routeRequestId  = 0;
var lastRouteOrigin = null;
var routeBusy       = false;

/*
 * Editable VGU road graph. Each edge follows a campus-road-like corridor;
 * building and room coordinates are never treated as road coordinates.
 * Gate 1 = east/main entry, Gate 2 = north entry, Gate 3 = west entry.
 */
var CAMPUS_GATES = {
  "Gate 1": [26.812677, 75.894521],
  "Gate 2": [26.813067, 75.891446],
  "Gate 3": [26.812604, 75.888329]
};

var CAMPUS_NODES = {
  gate1: CAMPUS_GATES["Gate 1"],
  gate2: CAMPUS_GATES["Gate 2"],
  gate3: CAMPUS_GATES["Gate 3"],
  northWest: [26.81260, 75.88955],
  northMid: [26.81270, 75.89075],
  northEast: [26.81268, 75.89335],
  westHub: [26.81248, 75.89060],
  academic: [26.81120, 75.88990],
  admin: [26.81246, 75.89135],
  southWest: [26.81135, 75.88980],
  mess: [26.81140, 75.89165],
  central: [26.81175, 75.89245],
  hostel: [26.81120, 75.89210],
  tech: [26.81220, 75.89378],
  southEast: [26.81175, 75.89320],
  sports: [26.81255, 75.89405],
  parking: [26.81290, 75.89295]
};

var CAMPUS_EDGES = [
  ["gate3", "northWest"], ["northWest", "northMid"],
  ["northMid", "gate2"], ["gate2", "northEast"],
  ["northEast", "gate1"], ["gate3", "westHub"],
  ["westHub", "admin"], ["admin", "tech"], ["tech", "gate1"],
  ["westHub", "southWest"], ["southWest", "academic"],
  ["academic", "mess"], ["mess", "central"], ["central", "hostel"],
  ["central", "southEast"], ["southEast", "tech"],
  ["central", "parking"], ["parking", "sports"], ["sports", "gate1"]
];

// Road-side entrance points for major campus zones. Room coordinates remain
// inside buildings; routing should end at these accessible road approaches.
var BUILDING_ROAD_ENTRIES = {
  "Tech Block": [26.81220, 75.89378],
  "Admin Block": [26.81246, 75.89135],
  "Mess Block": [26.81140, 75.89165],
  "Hostel": [26.81120, 75.89210],
  "Academic Block": [26.81120, 75.88990],
  "Academic Area": [26.81175, 75.89245],
  "Sports Area": [26.81255, 75.89405],
  "Campus Parking": [26.81290, 75.89295],
  "Main Gate": [26.81268, 75.89452],
  "Gate": [26.81260, 75.88835]
};

function nearestGate(lat, lng) {
  return Object.keys(CAMPUS_GATES).reduce(function (best, name) {
    var point = CAMPUS_GATES[name];
    var distance = haversine(lat, lng, point[0], point[1]);
    return distance < best.distance ? { name: name, point: point, distance: distance } : best;
  }, { name: "Gate 1", point: CAMPUS_GATES["Gate 1"], distance: Infinity });
}

function nearestCampusNode(lat, lng) {
  return Object.keys(CAMPUS_NODES).reduce(function (best, name) {
    var point = CAMPUS_NODES[name];
    var distance = haversine(lat, lng, point[0], point[1]);
    return distance < best.distance ? { name: name, point: point, distance: distance } : best;
  }, { name: "gate1", point: CAMPUS_NODES.gate1, distance: Infinity });
}

function campusPath(startName, endName) {
  var graph = {};
  Object.keys(CAMPUS_NODES).forEach(function (name) { graph[name] = []; });
  CAMPUS_EDGES.forEach(function (edge) {
    var a = edge[0], b = edge[1];
    var cost = haversine(CAMPUS_NODES[a][0], CAMPUS_NODES[a][1],
                         CAMPUS_NODES[b][0], CAMPUS_NODES[b][1]);
    graph[a].push({ node: b, cost: cost });
    graph[b].push({ node: a, cost: cost });
  });

  var distances = {}, previous = {}, open = Object.keys(CAMPUS_NODES);
  open.forEach(function (name) { distances[name] = Infinity; });
  distances[startName] = 0;
  while (open.length) {
    open.sort(function (a, b) { return distances[a] - distances[b]; });
    var current = open.shift();
    if (current === endName || distances[current] === Infinity) break;
    graph[current].forEach(function (edge) {
      var next = distances[current] + edge.cost;
      if (next < distances[edge.node]) {
        distances[edge.node] = next;
        previous[edge.node] = current;
      }
    });
  }

  var names = [], cursor = endName;
  while (cursor) {
    names.unshift(cursor);
    if (cursor === startName) break;
    cursor = previous[cursor];
  }
  return names[0] === startName ? names.map(function (name) { return CAMPUS_NODES[name]; }) : [];
}

function getRoadDestination() {
  if (!destinationData) return null;
  var entry = BUILDING_ROAD_ENTRIES[destinationData.building];
  return entry || [
    destinationData.entry_lat || destinationData.lat,
    destinationData.entry_lng || destinationData.lng
  ];
}

function campusRoadFallback(uLat, uLng, dLat, dLng) {
  var gate = nearestGate(uLat, uLng);
  var start = nearestCampusNode(uLat, uLng);
  var end = nearestCampusNode(dLat, dLng);
  var startNode = start.name.indexOf("gate") === 0 ? start.name : gate.name.toLowerCase().replace(" ", "");
  var inside = start.distance < 220;
  var internal = campusPath(inside ? startNode : gate.name.toLowerCase().replace(" ", ""), end.name);
  var points = [[uLat, uLng]];
  if (!inside) points.push(gate.point);
  if (internal.length) points = points.concat(internal);
  points.push([dLat, dLng]);
  return points;
}

function requestRoadRoute(points, requestId, fallbackPoints) {
  var coordinates = points.map(function (p) { return p[1] + "," + p[0]; }).join(";");
  var url = "https://router.project-osrm.org/route/v1/driving/" +
    coordinates + "?overview=full&geometries=geojson&steps=false";

  return fetch(url).then(function (response) {
    if (!response.ok) throw new Error("Road router returned " + response.status);
    return response.json();
  }).then(function (data) {
    if (requestId !== routeRequestId) return;
    if (!data.routes || !data.routes[0] || !data.routes[0].geometry) {
      throw new Error("No road route returned");
    }
    var latLngs = data.routes[0].geometry.coordinates.map(function (pair) {
      return [pair[1], pair[0]];
    });
    drawRouteLine(latLngs, false);
  }).catch(function (error) {
    if (requestId !== routeRequestId) return;
    console.warn("Road routing unavailable; using campus corridors", error);
    drawRouteLine(fallbackPoints, true);
  });
}

function drawRouteLine(latLngs, isFallback) {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(latLngs, {
    color: isFallback ? "#f59e0b" : "#4f46e5",
    weight: 6,
    opacity: 0.95,
    dashArray: isFallback ? "5, 9" : null,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(map);
  routeLine.bringToFront();
  var status = document.getElementById("routeStatus");
  if (status) status.textContent = isFallback ? "Campus path mode" : "Road route";
}

/* ── Icons ──────────────────────────────────────────────── */
function mkDestIcon() {
  return L.divIcon({
    className: "",
    html: "<div style='" +
      "background:linear-gradient(135deg,#4f46e5,#06b6d4);" +
      "width:38px;height:38px;border-radius:50% 50% 50% 0;" +
      "transform:rotate(-45deg);border:3px solid #fff;" +
      "box-shadow:0 4px 16px rgba(79,70,229,.65)'></div>",
    iconSize: [38,38], iconAnchor: [19,38]
  });
}
function mkUserIcon() {
  return L.divIcon({
    className: "user-location-marker",
    html: "<div class='user-location-wrap'>" +
            "<div class='user-accuracy-ring'></div>" +
            "<div class='user-heading' aria-hidden='true'></div>" +
            "<div class='user-avatar' aria-label='Your live location'>" +
              "<div class='avatar-head'></div><div class='avatar-body'></div>" +
              "<div class='avatar-pack'></div>" +
            "</div>" +
          "</div>",
    iconSize: [76,76], iconAnchor: [38,38]
  });
}

/* ── Map init ───────────────────────────────────────────── */
window.onload = function () {
  map = L.map("map", {
    center:      [CAMPUS_LAT, CAMPUS_LNG],
    zoom:        CAMPUS_ZOOM,
    minZoom:     16,
    maxZoom:     21,
    zoomControl: true,
    /* Prevent the map from wandering far from campus */
    maxBounds: [
      [CAMPUS_LAT - 0.03, CAMPUS_LNG - 0.04],
      [CAMPUS_LAT + 0.03, CAMPUS_LNG + 0.04]
    ],
    maxBoundsViscosity: 0.8
  });

  satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri", maxZoom: 21 }
  ).addTo(map);
  streetLayer = L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    { attribution: "© OpenStreetMap contributors", maxZoom: 21 }
  );

  /* Leaflet locate events */
  map.on("locationfound", onLocationFound);
  map.on("locationerror", onLocationError);

  setTimeout(() => map.invalidateSize(), 300);
  initMapControls();
  loadDestination();
};

function initMapControls() {
  var styleBtn = document.getElementById("mapStyleBtn");
  if (styleBtn) {
    styleBtn.addEventListener("click", function () {
      var satellite = styleBtn.dataset.mode === "satellite";
      if (satellite) {
        map.removeLayer(satelliteLayer);
        streetLayer.addTo(map);
        styleBtn.dataset.mode = "street";
        styleBtn.textContent = "✦ Satellite";
        showToast("Street map selected", 1800);
      } else {
        map.removeLayer(streetLayer);
        satelliteLayer.addTo(map);
        styleBtn.dataset.mode = "satellite";
        styleBtn.textContent = "◈ Street";
        showToast("Satellite map selected", 1800);
      }
    });
  }
  var compass = document.getElementById("compassBtn");
  if (compass) compass.addEventListener("click", function () {
    if (movementHeading !== null) {
      compass.style.transform = "rotate(" + (-movementHeading) + "deg)";
    } else {
      showToast("Walk a few metres to detect your travel direction", 2800);
    }
  });
}

// Calculate travel bearing between two GPS fixes. This ignores device angle.
function bearingBetween(a, b) {
  var lat1 = a.lat * Math.PI / 180;
  var lat2 = b.lat * Math.PI / 180;
  var dLng = (b.lng - a.lng) * Math.PI / 180;
  var y = Math.sin(dLng) * Math.cos(lat2);
  var x = Math.cos(lat1) * Math.sin(lat2) -
          Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Smooth compass wrap-around (359° → 0°) so the arrow does not jump.
function smoothHeading(next) {
  if (movementHeading === null) return next;
  var delta = ((next - movementHeading + 540) % 360) - 180;
  return (movementHeading + delta * 0.28 + 360) % 360;
}

function updateMovementHeading(heading) {
  movementHeading = smoothHeading(heading);
  var marker = document.querySelector(".user-location-marker .user-location-wrap");
  if (marker) {
    marker.style.setProperty("--heading", movementHeading + "deg");
    marker.classList.add("has-heading");
  }
  var compass = document.getElementById("compassBtn");
  if (compass) compass.style.transform = "rotate(" + (-movementHeading) + "deg)";
  var readout = document.getElementById("headingReadout");
  if (readout) readout.textContent = Math.round(movementHeading) + "°";
}

/* ── Load destination from /search ─────────────────────── */
function loadDestination() {
  if (!destination) return;

  fetch("/search?q=" + encodeURIComponent(destination))
    .then(r => r.json())
    .then(function(loc) {
      if (!loc || !loc.name) return;
      destinationData = loc;

      /* Floating panel */
      var panel = document.getElementById("floatingInfo");
      if (panel) {
        document.getElementById("fiTitle").textContent = loc.name;
        document.getElementById("fiMeta").textContent  =
          "🏢 " + loc.building + "  ·  " + loc.floor;
        panel.style.display = "block";
      }

      /* Marker */
      var popup =
        "<div style='font-family:Poppins,sans-serif;min-width:160px'>" +
        "<b>" + loc.name + "</b><br>" +
        "<span style='color:#64748b;font-size:12px'>" + loc.building + " · " + loc.floor + "</span>" +
        (loc.instructions ? "<br><small style='color:#94a3b8'>" + loc.instructions + "</small>" : "") +
        "</div>";

      destMarker = L.marker([loc.lat, loc.lng], { icon: mkDestIcon() })
        .addTo(map)
        .bindPopup(popup, { maxWidth: 220 })
        .openPopup();

      /* Zoom into destination at building level — no fitBounds */
      map.setView([loc.lat, loc.lng], CAMPUS_ZOOM, { animate: true });

      /* Auto-start live location */
      startLocating();
    })
    .catch(function(e) { console.error(e); });
}

/* ── Start continuous GPS watch ─────────────────────────── */
function startLocating() {
  if (locating) return;
  locating = true;
  setFabState("loading");

  map.locate({
    watch:             true,   /* continuous updates */
    enableHighAccuracy: true,
    timeout:           15000,
    maximumAge:        5000
  });
}

function locateUser() {
  /* Called by the FAB or "My Route" button */
  if (!locating) {
    startLocating();
  } else if (userMarker) {
    /* Already have location — just pan to user */
    map.setView(userMarker.getLatLng(), CAMPUS_ZOOM, { animate: true });
  } else {
    /* Restart locate */
    map.stopLocate();
    locating = false;
    startLocating();
  }
}

/* ── Location found ─────────────────────────────────────── */
function onLocationFound(e) {
  setFabState("active");

  var lat = e.latlng.lat;
  var lng = e.latlng.lng;
  var currentFix = { lat: lat, lng: lng, time: Date.now() };

  /*
   * Only accept a heading while the user is actually travelling.
   * This prevents GPS noise and phone-in-hand rotation from turning
   * the direction arrow while the user is standing still.
   */
  var speed = typeof e.speed === "number" ? e.speed : 0;
  var course = (typeof e.heading === "number" && e.heading >= 0) ? e.heading : null;
  if (lastPosition) {
    var elapsed = Math.max(0.5, (currentFix.time - lastPosition.time) / 1000);
    var moved = haversine(lastPosition.lat, lastPosition.lng, lat, lng);
    if (!course && moved >= 3) course = bearingBetween(lastPosition, currentFix);
    if (speed < 0.8 && moved / elapsed < 0.8) course = null;
  }
  if (course !== null && (speed >= 0.8 || !lastPosition || haversine(lastPosition.lat, lastPosition.lng, lat, lng) >= 3)) {
    updateMovementHeading(course);
  }
  lastPosition = currentFix;

  /* Update or create user marker */
  if (userMarker) {
    userMarker.setLatLng(e.latlng);
  } else {
    userMarker = L.marker(e.latlng, { icon: mkUserIcon() })
      .addTo(map)
      .bindPopup("<b>📍 You are here</b><br><small>" +
                 (e.accuracy ? "±" + Math.round(e.accuracy) + "m accuracy" : "") +
                 "</small>");
  }
  var ring = document.querySelector(".user-location-marker .user-accuracy-ring");
  if (ring && e.accuracy) {
    var px = Math.max(38, Math.min(150, e.accuracy * 0.8));
    ring.style.width = px + "px";
    ring.style.height = px + "px";
  }
  var accuracy = document.getElementById("accuracyReadout");
  if (accuracy && e.accuracy) accuracy.textContent = "±" + Math.round(e.accuracy) + "m GPS";

  if (destinationData) {
    var roadDestination = getRoadDestination();
    drawCampusRoute(lat, lng, roadDestination[0], roadDestination[1]);
  }
}

/* ── Location error ─────────────────────────────────────── */
function onLocationError(e) {
  setFabState("idle");
  locating = false;

  var msg = e.code === 1
    ? "Location access denied — tap the 📍 button and allow location"
    : "Can't detect location. Try tapping 📍 again";
  showToast(msg, 4000);
}

/* ── Draw real road route, with editable campus-corridor fallback ── */
function drawCampusRoute(uLat, uLng, dLat, dLng) {
  // GPS watch fires repeatedly; do not request a new route for every fix.
  var currentOrigin = [uLat, uLng];
  if (routeBusy && lastRouteOrigin &&
      haversine(lastRouteOrigin[0], lastRouteOrigin[1], uLat, uLng) < 18) return;
  if (lastRouteOrigin &&
      haversine(lastRouteOrigin[0], lastRouteOrigin[1], uLat, uLng) < 18) return;
  lastRouteOrigin = currentOrigin;
  routeBusy = true;
  var requestId = ++routeRequestId;
  var fallback = campusRoadFallback(uLat, uLng, dLat, dLng);
  requestRoadRoute([currentOrigin, [dLat, dLng]], requestId, fallback)
    .finally(function () { if (requestId === routeRequestId) routeBusy = false; });

  /* Distance + walking time uses the road-side destination */
  var dist   = haversine(uLat, uLng, dLat, dLng);
  var mins   = Math.max(1, Math.round(dist / 80));   /* ~80 m/min walking */
  var label  = dist < 1000
    ? Math.round(dist) + " m  ·  ~" + mins + " min walk"
    : (dist / 1000).toFixed(1) + " km  ·  ~" + mins + " min walk";

  /* Update info panel */
  var fiMeta = document.getElementById("fiMeta");
  if (fiMeta && destinationData) {
    fiMeta.textContent = "🏢 " + destinationData.building +
                         "  ·  🚶 " + label;
  }

  /* Keep both markers visible but never zoom out too far. */
  if (dist < 5000 && !routeLine) {
    var group = L.featureGroup([userMarker, destMarker]);
    var bounds = group.getBounds();
    map.fitBounds(bounds.pad(0.25), {
      animate:  true,
      maxZoom:  CAMPUS_ZOOM,     /* never zoom in tighter than needed */
      minZoom:  16               /* never zoom out past campus level  */
    });
  }
}

/* ── Haversine distance (metres) ────────────────────────── */
function haversine(lat1, lng1, lat2, lng2) {
  var R  = 6371000;
  var φ1 = lat1 * Math.PI / 180;
  var φ2 = lat2 * Math.PI / 180;
  var Δφ = (lat2 - lat1) * Math.PI / 180;
  var Δλ = (lng2 - lng1) * Math.PI / 180;
  var a  = Math.sin(Δφ/2)*Math.sin(Δφ/2) +
           Math.cos(φ1)*Math.cos(φ2)*Math.sin(Δλ/2)*Math.sin(Δλ/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

/* ── FAB state helpers ──────────────────────────────────── */
function setFabState(state) {
  var fab = document.querySelector(".locate-fab");
  if (!fab) return;
  if (state === "loading") { fab.textContent = "⏳"; fab.style.background = "#1e293b"; }
  else if (state === "active")  { fab.textContent = "📍"; fab.style.background = "#10b981"; }
  else                          { fab.textContent = "📍"; fab.style.background = ""; }
}

/* ── Toast notification ─────────────────────────────────── */
function showToast(msg, ms) {
  var el = document.createElement("div");
  el.style.cssText =
    "position:fixed;bottom:130px;left:50%;transform:translateX(-50%);" +
    "background:rgba(15,23,42,0.93);color:#94a3b8;font-size:12px;" +
    "font-family:Poppins,sans-serif;padding:9px 20px;border-radius:20px;" +
    "z-index:3000;pointer-events:none;white-space:nowrap;max-width:90vw;" +
    "text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.4);";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() { el.remove(); }, ms || 3000);
}
