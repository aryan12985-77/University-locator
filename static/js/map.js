/* ============================================================
   Campus Navigator — Full Page Map  |  VGU, Jaipur
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
    className: "",
    html: "<div style='position:relative;width:24px;height:24px'>" +
            "<div style='position:absolute;inset:0;border-radius:50%;" +
              "background:#10b981;border:3px solid #fff;" +
              "box-shadow:0 0 0 0 rgba(16,185,129,.5);" +
              "animation:gps-pulse 1.8s infinite'></div>" +
          "</div>",
    iconSize: [24,24], iconAnchor: [12,12]
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

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri", maxZoom: 21 }
  ).addTo(map);

  /* Leaflet locate events */
  map.on("locationfound", onLocationFound);
  map.on("locationerror", onLocationError);

  setTimeout(() => map.invalidateSize(), 300);
  loadDestination();
};

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

  if (destinationData) {
    drawCampusRoute(lat, lng,
      destinationData.entry_lat || destinationData.lat,
      destinationData.entry_lng || destinationData.lng);
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

/* ── Draw campus route (straight line — no OSRM needed) ── */
function drawCampusRoute(uLat, uLng, dLat, dLng) {
  /* Remove old line */
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }

  /* Dashed polyline: user → destination */
  routeLine = L.polyline(
    [[uLat, uLng], [dLat, dLng]],
    {
      color:     "#4f46e5",
      weight:    4,
      opacity:   0.85,
      dashArray: "10, 8",
      lineCap:   "round"
    }
  ).addTo(map);

  /* Distance + walking time */
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

  /* Keep both markers visible but NEVER zoom out past CAMPUS_ZOOM.
     Only adjust if user is on campus (within 500 m of centre). */
  if (dist < 5000) {
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
