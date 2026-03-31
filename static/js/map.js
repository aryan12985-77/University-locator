// ---------------- VARIABLES ----------------
var userLocation = null;
var routingControl = null;
var destinationMarker = null;
var destinationData = null;
var userMarker = null;

// ---------------- MAP INIT ----------------
var map = L.map('map');

window.onload = function () {

    map.setView([26.8123, 75.6924], 16);

    L.tileLayer(
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        { attribution: 'Tiles © Esri' }
    ).addTo(map);

    // Fix blank map
    setTimeout(() => {
        map.invalidateSize();
    }, 400);

    loadDestination();
};


// ---------------- LOAD DESTINATION ----------------
function loadDestination(){

    if(!destination) return;

    fetch("/search?q=" + destination)
    .then(res => res.json())
    .then(loc => {

        if(loc && loc.name){

            destinationData = loc;

            // ✅ CLEAN SIDEBAR (NO BIG IMAGE)
            document.getElementById("destinationInfo").innerHTML =
            "<b>Destination:</b> "+loc.name+"<br>"+
            "<b>Building:</b> "+loc.building+"<br>"+
            "<b>Floor:</b> "+loc.floor+"<br><br>"+
            (loc.instructions 
                ? "<b>Instructions:</b><br>"+loc.instructions 
                : ""
            );

            // ✅ AUTO GET USER LOCATION
            locateUser();

        } else {
            console.log("No location found");
        }

    })
    .catch(err => console.log(err));
}


// ---------------- UPDATE USER LOCATION ----------------
function updateUserLocation(lat, lng){

    userLocation = {lat: lat, lng: lng};

    if(userMarker){
        map.removeLayer(userMarker);
    }

    userMarker = L.marker([lat, lng])
    .addTo(map)
    .bindPopup("📍 You are here");

    drawRoute();
}


// ---------------- DRAW ROUTE ----------------
function drawRoute(){

    if(!destinationData || !userLocation) return;

    // remove old route
    if(routingControl){
        try{ map.removeControl(routingControl); }catch(e){}
        routingControl = null;
    }

    // remove old destination marker
    if(destinationMarker){
        try{ map.removeLayer(destinationMarker); }catch(e){}
        destinationMarker = null;
    }

    // ✅ ENTRY POINT (for routing)
    let destLat = destinationData.entry_lat || destinationData.lat;
    let destLng = destinationData.entry_lng || destinationData.lng;

    // ✅ POPUP CONTENT (SMALL IMAGE + TEXT)
    let popupContent =
        "<b>" + destinationData.name + "</b><br>" +
        "Floor: " + destinationData.floor + "<br><br>" +
        (destinationData.image 
            ? "<img src='" + destinationData.image + "' style='width:150px; border-radius:6px;'>"
            : ""
        ) +
        "<br>" +
        (destinationData.instructions 
            ? "<small>" + destinationData.instructions + "</small>"
            : ""
        );

    // ✅ DESTINATION MARKER
    destinationMarker = L.marker([destinationData.lat, destinationData.lng])
        .addTo(map)
        .bindPopup(popupContent)
        .openPopup();

    // ✅ ROUTE (to entry point)
    routingControl = L.Routing.control({
        waypoints:[
            L.latLng(userLocation.lat, userLocation.lng),
            L.latLng(destLat, destLng)
        ],
        lineOptions:{
            styles:[{color:'blue', weight:6}]
        },
        routeWhileDragging:false,
        addWaypoints:false,
        draggableWaypoints:false,
        createMarker: () => null
    }).addTo(map);

    // ✅ AUTO FIT MAP
    setTimeout(() => {
        try {
            let group = L.featureGroup([userMarker, destinationMarker]);
            map.fitBounds(group.getBounds().pad(0.3));
        } catch(e){}
    }, 500);
}


// ---------------- LOCATE USER ----------------
function locateUser(){

    if(!navigator.geolocation){
        alert("Geolocation not supported ❌");
        return;
    }

    navigator.geolocation.getCurrentPosition(

        function(position){
            updateUserLocation(
                position.coords.latitude,
                position.coords.longitude
            );
        },

        function(error){
            alert("Enable location access ❌");
            console.log(error);
        }
    );
}


// ---------------- BUTTON ----------------
window.addEventListener("DOMContentLoaded", function(){
    const btn = document.getElementById("locateBtn");
    if(btn){
        btn.addEventListener("click", locateUser);
    }
});


// ---------------- SIDEBAR ----------------
function toggleSidebar(){
    document.getElementById("sidebar").classList.toggle("hidden");

    setTimeout(() => {
        map.invalidateSize();
    }, 300);
}