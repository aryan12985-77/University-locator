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
var gateMarkers = [];
var campusLocations = [];
var nearestBuildingPopup = null;
var routeStartPosition = null;
var distanceTravelled = 0;

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
  cricketGround: [26.812312, 75.892432],
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
  ["academic", "mess"], ["mess", "cricketGround"],
  ["cricketGround", "central"], ["central", "hostel"],
  ["central", "southEast"], ["southEast", "tech"],
  ["cricketGround", "parking"], ["parking", "sports"], ["sports", "gate1"]
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

function isInsideCampus(lat, lng) {
  /* Editable safety boundary around the mapped VGU campus footprint. */
  var polygon = [
    [26.81282, 75.88815], [26.81328, 75.89472],
    [26.81055, 75.89472], [26.81045, 75.88935]
  ];
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var yi = polygon[i][0], xi = polygon[i][1];
    var yj = polygon[j][0], xj = polygon[j][1];
    var crosses = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function campusPath(startName, endName, blockedName) {
  var graph = {};
  Object.keys(CAMPUS_NODES).forEach(function (name) {
    if (name !== blockedName) graph[name] = [];
  });
  CAMPUS_EDGES.forEach(function (edge) {
    var a = edge[0], b = edge[1];
    if (a === blockedName || b === blockedName) return;
    var cost = haversine(CAMPUS_NODES[a][0], CAMPUS_NODES[a][1],
                         CAMPUS_NODES[b][0], CAMPUS_NODES[b][1]);
    graph[a].push({ node: b, cost: cost });
    graph[b].push({ node: a, cost: cost });
  });

  if (!graph[startName] || !graph[endName]) return [];
  var distances = {}, previous = {}, open = Object.keys(graph);
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

function pathDistance(points) {
  var total = 0;
  for (var i = 0; i < points.length - 1; i++) {
    total += haversine(points[i][0], points[i][1],
                       points[i + 1][0], points[i + 1][1]);
  }
  return total;
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
  var plan = campusRoutePlan(uLat, uLng, dLat, dLng);
  var points = [[uLat, uLng]];
  if (plan.outside) points.push(plan.gate.point);
  if (plan.path.length) {
    points = points.concat(plan.path.slice(plan.outside ? 1 : 0));
  }
  points.push([dLat, dLng]);
  return points;
}

function campusRoutePlan(uLat, uLng, dLat, dLng) {
  var outside = !isInsideCampus(uLat, uLng);
  var gate = nearestGate(uLat, uLng);
  var start = nearestCampusNode(uLat, uLng);
  var end = nearestCampusNode(dLat, dLng);
  var startNode = outside ? gate.name.toLowerCase().replace(" ", "") : start.name;
  var routeOrigin = outside ? gate.point : [uLat, uLng];
  var cricket = CAMPUS_NODES.cricketGround;
  var directDistance = haversine(routeOrigin[0], routeOrigin[1], dLat, dLng);
  var cricketDistance = haversine(routeOrigin[0], routeOrigin[1], cricket[0], cricket[1]);
  var shouldUseCricket = end.name !== "cricketGround" &&
    startNode !== "cricketGround" && directDistance > cricketDistance;
  var directPath = campusPath(startNode, end.name, "cricketGround");
  var path = directPath;

  /*
   * Short destinations stay direct. For longer campus trips, Cricket Ground
   * becomes one explicit waypoint. The direct path excludes it, so it cannot
   * appear merely because the graph happened to choose that branch.
   */
  if (!directPath.length) {
    directPath = campusPath(startNode, end.name);
    path = directPath;
  }
  if (shouldUseCricket) {
    var toCricket = campusPath(startNode, "cricketGround");
    var fromCricket = campusPath("cricketGround", end.name);
    if (toCricket.length && fromCricket.length) {
      path = toCricket.concat(fromCricket.slice(1));
    }
  }
  return {
    outside: outside,
    gate: gate,
    start: start,
    end: end,
    path: path,
    directDistance: directDistance,
    cricketDistance: cricketDistance,
    usesCricketGround: path.some(function (point) {
      return point[0] === CAMPUS_NODES.cricketGround[0] &&
             point[1] === CAMPUS_NODES.cricketGround[1];
    })
  };
}

function routeWaypoints(uLat, uLng, dLat, dLng) {
  var plan = campusRoutePlan(uLat, uLng, dLat, dLng);
  var points = [[uLat, uLng]];
  if (plan.outside) points.push(plan.gate.point);
  if (plan.path.length) {
    points = points.concat(plan.path.slice(plan.outside ? 1 : 0));
  }
  points.push([dLat, dLng]);
  return {
    points: points,
    outside: plan.outside,
    gateName: plan.outside ? plan.gate.name : null,
    usesCricketGround: plan.usesCricketGround
  };
}

function requestRoadRoute(points, requestId, fallbackPoints, routeLabel) {
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
    drawRouteLine(latLngs, false, routeLabel);
  }).catch(function (error) {
    if (requestId !== routeRequestId) return;
    console.warn("Road routing unavailable; using campus corridors", error);
    drawRouteLine(fallbackPoints, true, routeLabel);
  });
}

function drawRouteLine(latLngs, isFallback, routeLabel) {
  if (routeLine) map.removeLayer(routeLine);
  routeLine = L.polyline(latLngs, {
    color: "#4f46e5",
    weight: 6,
    opacity: 0.95,
    dashArray: null,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(map);
  routeLine.bringToFront();
  var status = document.getElementById("routeStatus");
  if (status) status.textContent = routeLabel || (isFallback ? "Campus path mode" : "Road route");
  updateRouteMetrics();
}

function distanceAlong(points, startIndex, startPoint) {
  var total = startPoint ? haversine(startPoint[0], startPoint[1],
                                     points[startIndex][0], points[startIndex][1]) : 0;
  for (var i = startIndex; i < points.length - 1; i++) {
    total += haversine(points[i][0], points[i][1],
                       points[i + 1][0], points[i + 1][1]);
  }
  return total;
}

function updateRouteMetrics() {
  if (!routeLine || !lastPosition) return;
  var points = routeLine.getLatLngs().map(function (point) {
    return [point.lat, point.lng];
  });
  if (points.length < 2) return;

  var nearest = points.reduce(function (best, point, index) {
    var distance = haversine(lastPosition.lat, lastPosition.lng, point[0], point[1]);
    return distance < best.distance ? { index: index, distance: distance } : best;
  }, { index: 0, distance: Infinity });
  var remaining = distanceAlong(points, nearest.index, [lastPosition.lat, lastPosition.lng]);
  var directionText = remaining < 25 ? "Arrived" : "—";
  if (remaining >= 25) {
    var directionPoint = points[Math.min(nearest.index + 1, points.length - 1)];
    var direction = bearingBetween(
      { lat: lastPosition.lat, lng: lastPosition.lng },
      { lat: directionPoint[0], lng: directionPoint[1] }
    );
    directionText = bearingLabel(direction);
  }
  var progress = document.getElementById("routeProgress");
  if (progress) {
    progress.textContent = formatRouteDistance(remaining) +
      " left · " + formatRouteDistance(distanceTravelled) + " moved";
  }
  var directionReadout = document.getElementById("routeDirectionReadout");
  if (directionReadout) directionReadout.textContent = "Next: " + directionText;
}

function formatRouteDistance(distance) {
  return distance < 1000 ? Math.round(distance) + " m" : (distance / 1000).toFixed(1) + " km";
}

function bearingLabel(degrees) {
  var labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return labels[Math.round(degrees / 45) % 8];
}

function updateNearestBuilding(lat, lng) {
  if (!isInsideCampus(lat, lng) || !campusLocations.length) {
    if (nearestBuildingPopup) {
      map.removeLayer(nearestBuildingPopup);
      nearestBuildingPopup = null;
    }
    return;
  }

  var buildings = {};
  campusLocations.forEach(function (location) {
    var building = location.building;
    if (!building || building === "Gate" || building === "Main Gate" ||
        building === "Security" || buildings[building]) return;
    buildings[building] = location;
  });
  var nearest = Object.keys(buildings).map(function (building) {
    var location = buildings[building];
    return {
      name: building,
      distance: haversine(lat, lng, location.lat, location.lng)
    };
  }).sort(function (a, b) { return a.distance - b.distance; })[0];
  if (!nearest) return;

  if (!nearestBuildingPopup) {
    nearestBuildingPopup = L.popup({
      closeButton: false,
      closeOnClick: false,
      autoClose: false,
      offset: [0, -28],
      className: "nearest-building-popup"
    }).addTo(map);
  }
  nearestBuildingPopup
    .setLatLng([lat, lng])
    .setContent("<strong>Near " + nearest.name + "</strong><small>" +
                formatRouteDistance(nearest.distance) + " away</small>")
    .openOn(map);
}

function updateActiveGateMarker(plan) {
  gateMarkers.forEach(function (marker) { map.removeLayer(marker); });
  gateMarkers = [];
  if (!plan.outside) return;
  Object.keys(CAMPUS_GATES).forEach(function (name) {
    var selected = name === plan.gate.name;
    var marker = L.circleMarker(CAMPUS_GATES[name], {
      radius: selected ? 9 : 6,
      color: "#fff",
      weight: selected ? 2 : 1.5,
      fillColor: selected ? "#f97316" : "#64748b",
      fillOpacity: selected ? 1 : 0.85
    }).bindTooltip(name + (selected ? " · nearest entry" : " · campus gate"), {
      permanent: true,
      direction: "top",
      offset: [0, -8],
      className: selected ? "campus-gate-label selected" : "campus-gate-label"
    }).addTo(map);
    gateMarkers.push(marker);
  });
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
  fetch("/api/locations")
    .then(function (response) { return response.json(); })
    .then(function (locations) { campusLocations = locations || []; })
    .catch(function (error) { console.warn("Building lookup unavailable", error); });
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
      routeStartPosition = null;
      distanceTravelled = 0;
      lastRouteOrigin = null;
      if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
      }

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
   * Ignore the browser-provided heading: on many phones it is derived from the compass/orientation
   * sensor and changes when the phone is tilted or rotated in the hand.
   * Calculate travel direction only from two GPS positions.
   */
  if (lastPosition) {
    var elapsed = Math.max(0.5, (currentFix.time - lastPosition.time) / 1000);
    var moved = haversine(lastPosition.lat, lastPosition.lng, lat, lng);
    if (moved >= 4 && moved / elapsed >= 0.8) {
      updateMovementHeading(bearingBetween(lastPosition, currentFix));
      if (moved < 250) distanceTravelled += moved;
    }
  } else {
    routeStartPosition = currentFix;
  }
  lastPosition = currentFix;
  updateNearestBuilding(lat, lng);
  updateRouteMetrics();

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
  var plan = routeWaypoints(uLat, uLng, dLat, dLng);
  var fallback = campusRoadFallback(uLat, uLng, dLat, dLng);
  updateActiveGateMarker(plan);
  var routeLabel = plan.outside
    ? "Road route via " + plan.gateName
    : "Shortest campus route";
  if (plan.usesCricketGround) routeLabel += " · via Cricket Ground";
  requestRoadRoute(plan.points, requestId, fallback, routeLabel)
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
