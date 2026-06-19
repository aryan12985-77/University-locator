/* ============================================================
   Campus Navigator — Full Page Map
   VGU, Jaipur  |  Campus coords ~26.8123, 75.8935
   ============================================================ */

var userLocation    = null;
var routingControl  = null;
var destinationMark = null;
var userMarker      = null;
var destinationData = null;
var map             = null;

/* Campus center fallback */
var CAMPUS = { lat: 26.8123, lng: 75.8935 };
var CAMPUS_ZOOM = 18;

/* ---------- CUSTOM ICONS ---------- */
function mkDestIcon() {
  return L.divIcon({
    className: "",
    html: "<div style='background:linear-gradient(135deg,#4f46e5,#06b6d4);" +
          "width:38px;height:38px;border-radius:50% 50% 50% 0;" +
          "transform:rotate(-45deg);border:3px solid white;" +
          "box-shadow:0 4px 16px rgba(79,70,229,0.6)'></div>",
    iconSize:   [38, 38],
    iconAnchor: [19, 38]
  });
}
function mkUserIcon() {
  return L.divIcon({
    className: "",
    html: "<div style='position:relative;width:22px;height:22px'>" +
            "<div style='position:absolute;inset:0;border-radius:50%;" +
                  "background:#10b981;border:3px solid white;" +
                  "box-shadow:0 2px 10px rgba(16,185,129,0.7)'></div>" +
            "<div style='position:absolute;inset:-6px;border-radius:50%;" +
                  "border:2px solid rgba(16,185,129,0.35);animation:none'></div>" +
          "</div>",
    iconSize:   [22, 22],
    iconAnchor: [11, 11]
  });
}

/* ---------- MAP INIT ---------- */
window.onload = function () {
  map = L.map("map", {
    center:  [CAMPUS.lat, CAMPUS.lng],
    zoom:    CAMPUS_ZOOM,
    minZoom: 15,
    maxZoom: 21,
    zoomControl: true
  });

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "© Esri", maxZoom: 21 }
  ).addTo(map);

  setTimeout(() => map.invalidateSize(), 300);
  loadDestination();
};

/* ---------- LOAD DESTINATION ---------- */
function loadDestination() {
  if (!destination) return;

  fetch("/search?q=" + encodeURIComponent(destination))
    .then(r => r.json())
    .then(loc => {
      if (!loc || !loc.name) {
        console.warn("Location not found for:", destination);
        return;
      }

      destinationData = loc;

      /* Update floating panel */
      const panel = document.getElementById("floatingInfo");
      if (panel) {
        document.getElementById("fiTitle").textContent = loc.name;
        document.getElementById("fiMeta").textContent  =
          "🏢 " + loc.building + "  ·  📶 " + loc.floor;
        panel.style.display = "block";
      }

      /* Place destination marker */
      const popupHtml =
        "<div style='font-family:Poppins,sans-serif;min-width:160px'>" +
        "<b style='font-size:14px'>" + loc.name + "</b><br>" +
        "<span style='color:#64748b;font-size:12px'>" +
          loc.building + " &nbsp;·&nbsp; " + loc.floor +
        "</span>" +
        (loc.image
          ? "<br><img src='" + loc.image +
            "' style='width:100%;margin-top:8px;border-radius:8px;" +
            "max-height:120px;object-fit:cover'>"
          : "") +
        (loc.instructions
          ? "<p style='color:#64748b;font-size:11px;margin-top:6px'>" +
            loc.instructions + "</p>"
          : "") +
        "</div>";

      destinationMark = L.marker([loc.lat, loc.lng], { icon: mkDestIcon() })
        .addTo(map)
        .bindPopup(popupHtml, { maxWidth: 220 })
        .openPopup();

      /* Zoom into destination at campus level */
      map.setView([loc.lat, loc.lng], CAMPUS_ZOOM);

      /* Now try to get live location */
      locateUser();
    })
    .catch(e => console.error("Search error:", e));
}

/* ---------- UPDATE USER LOCATION ---------- */
function updateUserLocation(lat, lng) {
  userLocation = { lat, lng };

  if (userMarker) {
    map.removeLayer(userMarker);
  }

  userMarker = L.marker([lat, lng], { icon: mkUserIcon() })
    .addTo(map)
    .bindPopup(
      "<b style='font-family:Poppins,sans-serif'>📍 You are here</b>"
    );

  drawRoute();
}

/* ---------- DRAW ROUTE ---------- */
function drawRoute() {
  if (!destinationData || !userLocation) return;

  /* Remove old routing control cleanly */
  if (routingControl) {
    try { map.removeControl(routingControl); } catch(e) {}
    routingControl = null;
  }

  const dLat = destinationData.entry_lat || destinationData.lat;
  const dLng = destinationData.entry_lng || destinationData.lng;

  routingControl = L.Routing.control({
    waypoints: [
      L.latLng(userLocation.lat, userLocation.lng),
      L.latLng(dLat, dLng)
    ],
    lineOptions: {
      styles: [{ color: "#4f46e5", weight: 5, opacity: 0.9 }]
    },
    routeWhileDragging:  false,
    addWaypoints:        false,
    draggableWaypoints:  false,
    createMarker:        () => null,
    show:                false,
    collapsible:         true,
    collapsed:           true
  }).addTo(map);

  /* Fit both markers but KEEP campus-level zoom (never zoom out to country) */
  routingControl.on("routesfound", function() {
    if (!userMarker || !destinationMark) return;
    try {
      const group = L.featureGroup([userMarker, destinationMark]);
      map.fitBounds(group.getBounds().pad(0.25), { maxZoom: CAMPUS_ZOOM });
    } catch(e) {}
  });
}

/* ---------- LOCATE USER ---------- */
function locateUser() {
  if (!navigator.geolocation) {
    showMapNote("Geolocation not supported by this browser");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      updateUserLocation(pos.coords.latitude, pos.coords.longitude);
    },
    function(err) {
      console.warn("GPS denied or unavailable:", err.message);
      showMapNote("📍 Allow location access to see your route");
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
  );
}

/* Small toast note on the map */
function showMapNote(msg) {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;bottom:120px;left:50%;transform:translateX(-50%);" +
    "background:rgba(15,23,42,0.9);color:#94a3b8;font-size:12px;" +
    "font-family:Poppins,sans-serif;padding:8px 18px;border-radius:20px;" +
    "z-index:2000;pointer-events:none;";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}
