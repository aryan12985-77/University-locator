/* ============================================================
   Campus Navigator — Map Logic
   ============================================================ */

var userLocation    = null;
var routingControl  = null;
var destinationMark = null;
var userMarker      = null;
var destinationData = null;
var map             = null;

/* ---------- ICONS ---------- */
function destIcon() {
  return L.divIcon({
    className: "",
    html: "<div style='background:linear-gradient(135deg,#4f46e5,#06b6d4);width:38px;height:38px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:3px solid white;box-shadow:0 4px 14px rgba(0,0,0,0.45)'></div>",
    iconSize:   [38, 38],
    iconAnchor: [19, 38]
  });
}
function userIcon() {
  return L.divIcon({
    className: "",
    html: "<div style='width:18px;height:18px;border-radius:50%;background:#10b981;border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4)'></div>",
    iconSize:   [18, 18],
    iconAnchor: [9, 9]
  });
}

/* ---------- INIT ---------- */
window.onload = function () {
  map = L.map("map", { zoomControl: true });
  map.setView([26.8123, 75.8935], 17);

  L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { attribution: "Tiles © Esri", maxZoom: 21 }
  ).addTo(map);

  setTimeout(() => map.invalidateSize(), 400);
  loadDestination();
};

/* ---------- LOAD DESTINATION ---------- */
function loadDestination() {
  if (!destination) return;

  fetch("/search?q=" + encodeURIComponent(destination))
    .then(r => r.json())
    .then(loc => {
      if (!loc || !loc.name) { console.warn("Location not found"); return; }

      destinationData = loc;

      /* Floating panel */
      const panel = document.getElementById("floatingInfo");
      if (panel) {
        document.getElementById("fiTitle").textContent = loc.name;
        document.getElementById("fiMeta").textContent  =
          "🏢 " + loc.building + "  ·  📶 " + loc.floor;
        panel.style.display = "block";
      }

      /* Destination marker */
      const popup =
        "<b>" + loc.name + "</b><br>" +
        loc.building + " · " + loc.floor +
        (loc.image ? "<br><img src='" + loc.image + "' style='width:140px;border-radius:8px;margin-top:8px;'>" : "") +
        (loc.instructions ? "<br><small style='color:#94a3b8'>" + loc.instructions + "</small>" : "");

      destinationMark = L.marker([loc.lat, loc.lng], { icon: destIcon() })
        .addTo(map)
        .bindPopup(popup)
        .openPopup();

      map.setView([loc.lat, loc.lng], 18);
      locateUser();
    })
    .catch(e => console.error(e));
}

/* ---------- UPDATE USER LOCATION ---------- */
function updateUserLocation(lat, lng) {
  userLocation = { lat, lng };

  if (userMarker) map.removeLayer(userMarker);
  userMarker = L.marker([lat, lng], { icon: userIcon() })
    .addTo(map)
    .bindPopup("📍 You are here");

  drawRoute();
}

/* ---------- DRAW ROUTE ---------- */
function drawRoute() {
  if (!destinationData || !userLocation) return;

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
    routeWhileDragging: false,
    addWaypoints:       false,
    draggableWaypoints: false,
    createMarker:       () => null,
    show:               false
  }).addTo(map);

  setTimeout(() => {
    try {
      const group = L.featureGroup([userMarker, destinationMark]);
      map.fitBounds(group.getBounds().pad(0.28));
    } catch(e) {}
  }, 600);
}

/* ---------- LOCATE USER ---------- */
function locateUser() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  navigator.geolocation.getCurrentPosition(
    pos => updateUserLocation(pos.coords.latitude, pos.coords.longitude),
    err => console.warn("Location denied:", err)
  );
}
