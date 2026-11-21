/* global maplibregl, L, Threebox, THREE */
/* Route Drive, driven by the real speedometer.
   Position, heading and speed come from window.Apex (speedometer.js). Nothing is simulated. */
(function () {
  const START = [3.3792, 6.5244]; // only the map's opening view, until the first real location arrives
  const state = { route: null, car: null, threebox: null, destination: null, destCoords: null, origin: null, suggestionTimer: null, suggestionRequest: null, lastSearchAt: 0, cam: { lat: 0, lon: 0, hd: 0, init: false, hold: 0 }, lastFrame: 0, lastUi: 0, lastReroute: 0, centered: false, busy: false, distance: 0, demoDone: false, wasDemo: false, demoCam: 0, demoHint: false };
  const status = document.querySelector("#route-status");
  const destinationInput = document.querySelector("#destination");
  const suggestions = document.querySelector("#destination-suggestions");
  const driveStage = document.querySelector("#drive-stage");
  const nextTurnIcon = document.querySelector("#next-turn-icon");
  const nextTurnText = document.querySelector("#next-turn-text");
  const nextTurnDistance = document.querySelector("#next-turn-distance");
  const etaValue = document.querySelector("#eta-value");

  const map = new maplibregl.Map({
    container: "map", center: START, zoom: 12, pitch: 0, bearing: 0, antialias: true,
    style: { version: 8, sources: { osm: { type: "raster", tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 19, attribution: "© OpenStreetMap contributors" } }, layers: [{ id: "bg", type: "background", paint: { "background-color": "#0a0e14" } }, { id: "osm", type: "raster", source: "osm", paint: { "raster-brightness-min": .92, "raster-brightness-max": .1, "raster-saturation": -.45, "raster-hue-rotate": 200, "raster-contrast": .15 } }] }
  });
  map.addControl(new maplibregl.NavigationControl(), "bottom-right");

  map.on("load", () => {
    addRouteLayers();
    map.addLayer(threeboxLayer());
    locate(true);
    requestAnimationFrame(frame);
  });

  function addRouteLayers() {
    map.addSource("route-geojson", { type: "geojson", data: emptyFeature() });
    map.addLayer({ id: "route-shadow", type: "line", source: "route-geojson", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#06090e", "line-width": 13, "line-opacity": .75 } });
    map.addLayer({ id: "route-path", type: "line", source: "route-geojson", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#e6c36a", "line-width": 7 } });
  }

  function threeboxLayer() {
    return {
      id: "threebox-car", type: "custom", renderingMode: "3d",
      onAdd(mapInstance, gl) {
        window.tb = new Threebox(mapInstance, gl, { defaultLights: true, enableSelectingObjects: false, enableTooltips: false });
        state.threebox = window.tb;
        state.car = state.threebox.Object3D({ obj: createCarMesh(), units: "meters", anchor: "center", adjustment: { x: 0, y: 0, z: .5 } });
        state.car.setCoords(START);
        state.car.visibility = false;
        state.threebox.add(state.car);
      },
      render() { state.threebox.update(); }
    };
  }

  function createCarMesh() {
    const vehicle = new THREE.Group();
    const paint = new THREE.MeshPhongMaterial({ color: 0xff9d3c, shininess: 80 });
    const glass = new THREE.MeshPhongMaterial({ color: 0x18334b, shininess: 100 });
    const tyre = new THREE.MeshPhongMaterial({ color: 0x10131a });
    const base = new THREE.Mesh(new THREE.BoxGeometry(2, 4.5, .8), paint);
    base.position.z = .45;
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.65, 2.1, .75), glass);
    cabin.position.set(0, -.25, 1.2);
    vehicle.add(base, cabin);
    [[-1.05, -1.35], [1.05, -1.35], [-1.05, 1.35], [1.05, 1.35]].forEach(([x, y]) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(.38, .38, .25, 12), tyre);
      wheel.rotation.y = Math.PI / 2;
      wheel.position.set(x, y, .35);
      vehicle.add(wheel);
    });
    return vehicle;
  }

  /* ---------- real position, from the speedometer ---------- */
  const live = () => (window.Apex ? window.Apex.get() : null);
  function currentOrigin() {
    const a = live();
    if (a && a.pos) return [a.pos.lon, a.pos.lat];
    if (state.origin) return state.origin;
    return a && a.demo ? START : null; // Demo can run without a location, from the original start point
  }

  document.querySelector("#destination-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("destination").trim();
    if (!query || state.busy) return;
    state.busy = true;
    try {
      const origin = currentOrigin();
      if (!origin) throw new Error("No location yet. Press Start on the speedometer (or Use my location), then try again.");
      setStatus("Finding the destination…");
      hideSuggestions();
      const destination = state.destination?.query === query ? state.destination.coordinates : await resolveDestination(query);
      setStatus("Leaflet Routing Machine is generating the route…");
      const result = await routeWithLeaflet(origin, destination);
      state.destCoords = destination;
      applyRoute(result);
      fitRoute(result.coordinates);
      state.cam.hold = performance.now() + 10000;
      setStatus(`Route ready: ${(state.route.totalMeters / 1000).toFixed(1)} km. Drive and the map follows your real position.`);
    } catch (error) { setStatus(error.message || "Route could not be created."); }
    state.busy = false;
  });

  function locate(quiet) {
    if (!navigator.geolocation) return quiet || setStatus("This browser does not support location.");
    navigator.geolocation.getCurrentPosition((position) => {
      state.origin = [position.coords.longitude, position.coords.latitude];
      if (quiet) { if (!state.centered) map.jumpTo({ center: state.origin, zoom: 13 }); return; }
      map.flyTo({ center: state.origin, zoom: 14, duration: 700 });
      setStatus("Location found. Now choose a destination.");
    }, () => { if (!quiet) setStatus("Location permission was not granted. Allow it, then press Start on the speedometer."); }, { enableHighAccuracy: !quiet, timeout: 10000, maximumAge: 600000 });
  }
  document.querySelector("#locate-button").addEventListener("click", () => locate(false));

  destinationInput.addEventListener("input", () => {
    state.destination = null;
    window.clearTimeout(state.suggestionTimer);
    const query = destinationInput.value.trim();
    if (query.length < 3) return hideSuggestions();
    state.suggestionTimer = window.setTimeout(() => showSuggestions(query), 650);
  });
  destinationInput.addEventListener("blur", () => window.setTimeout(hideSuggestions, 180));

  async function resolveDestination(query) {
    const coordinates = parseCoordinates(query);
    if (coordinates) return coordinates;
    const mapInput = await parseGoogleMapsInput(query);
    if (mapInput?.coordinates) return mapInput.coordinates;
    return geocode(mapInput?.query || query);
  }

  async function geocode(query) {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.search = new URLSearchParams({ q: query, format: "jsonv2", limit: "1" });
    const response = await fetch(url, { headers: { Accept: "application/json" } });
    const matches = await response.json();
    if (!response.ok || !matches[0]) throw new Error("Address not found. Use a fuller destination, including its city.");
    return [Number(matches[0].lon), Number(matches[0].lat)];
  }

  async function showSuggestions(query) {
    const localCoordinates = parseCoordinates(query);
    if (localCoordinates) return renderSuggestions([{ label: "Use these coordinates", detail: `${localCoordinates[1].toFixed(6)}, ${localCoordinates[0].toFixed(6)}`, coordinates: localCoordinates }]);
    const waitForSearch = Math.max(0, state.lastSearchAt + 1000 - Date.now());
    if (waitForSearch) { state.suggestionTimer = window.setTimeout(() => showSuggestions(query), waitForSearch); return; }
    if (state.suggestionRequest) state.suggestionRequest.abort();
    state.suggestionRequest = new AbortController();
    try {
      const mapInput = await parseGoogleMapsInput(query);
      if (mapInput?.coordinates) return renderSuggestions([{ label: "Use location from Google Maps", detail: `${mapInput.coordinates[1].toFixed(6)}, ${mapInput.coordinates[0].toFixed(6)}`, coordinates: mapInput.coordinates }]);
      const searchText = mapInput?.query || query;
      const url = new URL("https://nominatim.openstreetmap.org/search");
      url.search = new URLSearchParams({ q: searchText, format: "jsonv2", addressdetails: "1", namedetails: "1", limit: "6" });
      state.lastSearchAt = Date.now();
      const response = await fetch(url, { headers: { Accept: "application/json" }, signal: state.suggestionRequest.signal });
      const matches = await response.json();
      if (!response.ok) throw new Error("Search unavailable");
      renderSuggestions(matches.map((match) => ({ label: match.name || match.namedetails?.name || match.display_name.split(",")[0], detail: match.display_name, coordinates: [Number(match.lon), Number(match.lat)] })));
    } catch (error) { if (error.name !== "AbortError") hideSuggestions(); }
  }

  function renderSuggestions(items) {
    if (!items.length) return hideSuggestions();
    suggestions.replaceChildren(...items.map((item) => {
      const option = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button"; button.role = "option";
      button.innerHTML = `${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small>`;
      button.addEventListener("mousedown", (event) => { event.preventDefault(); chooseSuggestion(item); });
      option.append(button);
      return option;
    }));
    suggestions.classList.add("visible");
  }

  function chooseSuggestion(item) {
    destinationInput.value = item.label;
    state.destination = { query: item.label, coordinates: item.coordinates };
    hideSuggestions();
    setStatus("Destination selected. Select Create route when ready.");
  }

  function hideSuggestions() { suggestions.classList.remove("visible"); suggestions.replaceChildren(); }
  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]); }

  function parseCoordinates(input) {
    const geoJsonPair = input.trim().match(/^\[\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,2}(?:\.\d+)?)\s*\]$/);
    if (geoJsonPair) return validCoordinates(Number(geoJsonPair[2]), Number(geoJsonPair[1]));
    const labelled = input.match(/(?:lat(?:itude)?\s*[:=]\s*)(-?\d+(?:\.\d+)?).*?(?:lng|lon(?:gitude)?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/i);
    if (labelled) return validCoordinates(Number(labelled[1]), Number(labelled[2]));
    const reverseLabelled = input.match(/(?:lng|lon(?:gitude)?\s*[:=]\s*)(-?\d+(?:\.\d+)?).*?(?:lat(?:itude)?\s*[:=]\s*)(-?\d+(?:\.\d+)?)/i);
    if (reverseLabelled) return validCoordinates(Number(reverseLabelled[2]), Number(reverseLabelled[1]));
    const pair = input.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
    return pair ? validCoordinates(Number(pair[1]), Number(pair[2])) : null;
  }

  function validCoordinates(latitude, longitude) { return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? [longitude, latitude] : null; }

  async function parseGoogleMapsInput(input) {
    if (!/^https?:\/\//i.test(input)) return null;
    let url;
    try { url = new URL(input); } catch { return null; }
    if (url.hostname === "maps.app.goo.gl" || url.hostname === "goo.gl") {
      try {
        const response = await fetch(`/resolve-map-link?url=${encodeURIComponent(url.href)}`);
        if (response.ok) return parseGoogleMapsInput((await response.json()).url);
      } catch { }
      try {
        const response = await fetch(url.href, { redirect: "follow" });
        return parseGoogleMapsInput(response.url);
      } catch { throw new Error("That short Google Maps link could not be opened. Paste its full Google Maps link instead."); }
    }
    const coordinateMatch = url.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/) || url.href.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
    if (coordinateMatch) return { coordinates: validCoordinates(Number(coordinateMatch[1]), Number(coordinateMatch[2])) };
    const query = url.searchParams.get("q") || url.searchParams.get("query") || url.searchParams.get("ll") || url.pathname.match(/\/maps\/place\/([^/]+)/)?.[1]?.replace(/\+/g, " ");
    if (!query) return null;
    return { coordinates: parseCoordinates(query), query: parseCoordinates(query) ? null : query };
  }

  function routeWithLeaflet(origin, destination) {
    const router = L.Routing.osrmv1({ serviceUrl: "https://router.project-osrm.org/route/v1", profile: "driving", routingOptions: { alternatives: false, steps: true } });
    const waypoints = [L.Routing.waypoint(L.latLng(origin[1], origin[0])), L.Routing.waypoint(L.latLng(destination[1], destination[0]))];
    return new Promise((resolve, reject) => router.route(waypoints, (error, routes) => {
      if (error || !routes?.[0]?.coordinates?.length) return reject(new Error("Routing failed. The public OSRM service may be busy; try again shortly."));
      // Leaflet Routing Machine provides LatLngs. This converts them to standard GeoJSON [lng, lat] positions.
      resolve({ coordinates: routes[0].coordinates.map((point) => [point.lng, point.lat]), duration: routes[0].summary?.totalTime || 0 });
    }));
  }

  function applyRoute(result) {
    state.route = buildMeasuredRoute(result.coordinates);
    state.route.index = 0; state.route.off = 0;
    state.route.duration = result.duration || state.route.totalMeters / 13;
    updateRouteGeoJSON(result.coordinates);
    state.distance = 0; state.demoDone = false;
    if (state.car) {
      state.car.setCoords(result.coordinates[0]);
      state.car.setRotation({ x: 0, y: 0, z: -state.route.points[0].bearing });
      state.car.visibility = true;
    }
    updateGuidance(0, 0);
  }

  function updateRouteGeoJSON(coordinates) {
    map.getSource("route-geojson").setData({ type: "Feature", properties: { source: "Leaflet Routing Machine" }, geometry: { type: "LineString", coordinates } });
  }

  function buildMeasuredRoute(coordinates) {
    let totalMeters = 0;
    const points = coordinates.map((coordinate, index) => {
      if (index) totalMeters += metersBetween(coordinates[index - 1], coordinate);
      return { coordinate, meters: totalMeters, bearing: index ? bearing(coordinates[index - 1], coordinate) : 0 };
    });
    if (points.length > 1) points[0].bearing = points[1].bearing;
    return { points, totalMeters, turns: findTurns(points) };
  }

  /* ---------- per-frame: follow the real position ---------- */
  function frame(now) {
    requestAnimationFrame(frame);
    if (now - state.lastFrame < 33) return;
    const dt = Math.min(.1, (now - state.lastFrame) / 1000);
    state.lastFrame = now;
    const a = live();
    if (a && a.demo && state.car) { demoStep(now, dt, a); return; }
    state.wasDemo = false;
    if (!a || !a.pos || !state.car) return;

    // dead-reckon from the last fix so the car glides between 1 Hz GPS updates
    const age = Math.min(a.age, 2), d = a.v * age, h = (a.hd || 0) * Math.PI / 180;
    const la = a.pos.lat + d * Math.cos(h) / 111320;
    const lo = a.pos.lon + d * Math.sin(h) / (111320 * Math.cos(a.pos.lat * Math.PI / 180));
    const c = state.cam;
    if (!c.init) { c.lat = la; c.lon = lo; c.hd = a.hd || 0; c.init = true; }
    const k = 1 - Math.exp(-dt * 6);
    c.lat += (la - c.lat) * k; c.lon += (lo - c.lon) * k;

    let prog = 0;
    if (state.route) prog = trackProgress(c, a.v, now);
    const target = a.hd != null && a.v > 1 ? a.hd : (state.route ? state.route.points[state.route.index].bearing : (a.hd != null ? a.hd : c.hd));
    c.hd += (((target - c.hd + 540) % 360) - 180) * (1 - Math.exp(-dt * 3));

    state.car.setCoords([c.lon, c.lat]);
    state.car.setRotation({ x: 0, y: 0, z: -c.hd });
    state.car.visibility = true;

    if (!state.centered) { state.centered = true; map.jumpTo({ center: [c.lon, c.lat], zoom: 15 }); }
    else if (a.v >= 3 && now > c.hold) map.jumpTo({ center: [c.lon, c.lat], zoom: 18, pitch: 70, bearing: c.hd });
    map.triggerRepaint();

    if (state.route && now - state.lastUi > 250) { state.lastUi = now; updateGuidance(prog, a.v); }
  }

  /* ---------- Demo: the car drives the route (original animation from the first file) ---------- */
  function demoStep(now, dt, a) {
    if (!state.wasDemo) {
      state.wasDemo = true;
      if (state.demoDone) { state.distance = 0; state.demoDone = false; }
    }
    const route = state.route;
    if (!route) {
      if (!state.demoHint) { state.demoHint = true; setStatus("Demo is running. Create a route and the car will drive it."); }
      return;
    }
    if (state.demoDone) return;
    state.distance = Math.min(route.totalMeters, state.distance + a.v * dt);
    const pose = poseAtDistance(route, state.distance);
    state.car.setCoords(pose.coordinate);
    state.car.setRotation({ x: 0, y: 0, z: -pose.bearing });
    state.car.visibility = true;
    if (now - state.demoCam > 80) { followCamera(pose); state.demoCam = now; }
    if (now - state.lastUi > 100) { state.lastUi = now; updateGuidance(state.distance, a.v); }
    map.triggerRepaint();
    if (state.distance >= route.totalMeters) {
      state.demoDone = true;
      updateGuidance(route.totalMeters, 0);
      setStatus("Arrived. Press Demo twice to drive it again, or create another route.");
    }
  }

  function poseAtDistance(route, targetMeters) {
    const index = route.points.findIndex((point) => point.meters >= targetMeters);
    if (index <= 0) return route.points[0];
    const next = route.points[index], previous = route.points[index - 1];
    const amount = (targetMeters - previous.meters) / Math.max(1, next.meters - previous.meters);
    return { coordinate: [previous.coordinate[0] + (next.coordinate[0] - previous.coordinate[0]) * amount, previous.coordinate[1] + (next.coordinate[1] - previous.coordinate[1]) * amount], bearing: next.bearing };
  }

  function followCamera(pose) { map.jumpTo({ center: pose.coordinate, zoom: 18, pitch: 70, bearing: pose.bearing }); }

  function trackProgress(c, speed, now) {
    const r = state.route, end = Math.min(r.points.length, r.index + 120);
    let best = r.index, bestDistance = Infinity;
    for (let i = r.index; i < end; i += 1) {
      const dist = metersBetween([c.lon, c.lat], r.points[i].coordinate);
      if (dist < bestDistance) { bestDistance = dist; best = i; }
    }
    r.index = best; r.off = bestDistance;
    if (bestDistance > 80 && speed > 3 && now - state.lastReroute > 15000 && state.destCoords) reroute(now);
    return r.points[best].meters;
  }

  async function reroute(now) {
    state.lastReroute = now;
    try {
      const origin = currentOrigin();
      if (!origin) return;
      const result = await routeWithLeaflet(origin, state.destCoords);
      applyRoute(result);
      setStatus("Off route. New route created from where you are.");
    } catch (error) { /* try again in 15 s */ }
  }

  function findTurns(points) {
    const turns = [];
    let sampledIndex = 0, lastTurnAt = -Infinity;
    for (let index = 1; index < points.length; index += 1) {
      if (points[index].meters - points[sampledIndex].meters < 35) continue;
      const delta = normaliseAngle(points[index].bearing - points[sampledIndex].bearing);
      if (Math.abs(delta) >= 28 && points[index].meters - lastTurnAt > 60) {
        turns.push({ meters: points[index].meters, direction: delta > 0 ? "right" : "left" });
        lastTurnAt = points[index].meters;
      }
      sampledIndex = index;
    }
    return turns;
  }

  function updateGuidance(progress, speed) {
    const r = state.route;
    if (!r) return;
    const remaining = Math.max(0, r.totalMeters - progress);
    driveStage.classList.remove("left", "right", "straight");
    if (remaining < 25) {
      driveStage.classList.add("straight");
      nextTurnIcon.textContent = "⚑"; nextTurnText.textContent = "You have arrived"; nextTurnDistance.textContent = "Destination reached"; etaValue.textContent = "–";
      return;
    }
    const turn = r.turns.find((item) => item.meters > progress + 8);
    if (!turn) {
      driveStage.classList.add("straight");
      nextTurnIcon.textContent = "↑"; nextTurnText.textContent = "Continue to destination"; nextTurnDistance.textContent = `${formatDistance(remaining)} remaining`;
    } else {
      driveStage.classList.add(turn.direction);
      nextTurnIcon.textContent = "↑"; nextTurnText.textContent = `Turn ${turn.direction}`; nextTurnDistance.textContent = `In ${formatDistance(turn.meters - progress)}`;
    }
    const routeSpeed = r.totalMeters / Math.max(1, r.duration), realSpeed = speed > 1 ? speed : routeSpeed;
    etaValue.textContent = formatDuration(remaining / Math.max(3, .5 * routeSpeed + .5 * realSpeed));
  }

  function formatDuration(seconds) {
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 1) return "< 1 min";
    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  }
  function formatDistance(meters) { return meters < 1000 ? `${Math.max(10, Math.round(meters / 10) * 10)} m` : `${(meters / 1000).toFixed(1)} km`; }
  function normaliseAngle(angle) { return ((angle + 540) % 360) - 180; }
  function fitRoute(coordinates) { const bounds = coordinates.reduce((result, coordinate) => result.extend(coordinate), new maplibregl.LngLatBounds(coordinates[0], coordinates[0])); map.fitBounds(bounds, { padding: 100, duration: 900, pitch: 0, bearing: 0 }); }
  function emptyFeature() { return { type: "FeatureCollection", features: [] }; }
  function metersBetween(a, b) { const radians = Math.PI / 180, earthRadius = 6371000, dLat = (b[1] - a[1]) * radians, dLng = (b[0] - a[0]) * radians; const value = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dLng / 2) ** 2; return 2 * earthRadius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value)); }
  function bearing(a, b) { const radians = Math.PI / 180, longitude = (b[0] - a[0]) * radians, start = a[1] * radians, end = b[1] * radians; return Math.atan2(Math.sin(longitude) * Math.cos(end), Math.cos(start) * Math.sin(end) - Math.sin(start) * Math.cos(end) * Math.cos(longitude)) * 180 / Math.PI; }
  function setStatus(message) { status.textContent = message; }
}());
