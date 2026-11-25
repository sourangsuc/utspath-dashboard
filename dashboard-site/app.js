const studyBounds = [[54.2, -25.5], [71.7, 35.5]];
const map = L.map("map", { zoomControl: true, minZoom: 3 }).fitBounds(studyBounds);
L.tileLayer("https://tile.openstreetmap.de/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "© OpenStreetMap contributors",
}).addTo(map);

const norwayBoundaryColor = "#64748b";
const otherBoundaryColor = "#2563eb";
const stationLayer = L.layerGroup().addTo(map);
const metStationLayer = L.layerGroup().addTo(map);
const ecadStationLayer = L.layerGroup().addTo(map);
const nbsLayer = L.layerGroup();
map.createPane("nbs-areas").style.zIndex = 410;
map.createPane("nbs-points").style.zIndex = 450;
const citiesByName = new Map();
let selectedCity = null;
let selectedStation = null;
let selectedStationSource = "netatmo";
let activeStations = [];
let cityLoadController = null;
let selectedView = "weather";
let nbsLoadController = null;
let nbsPayload = null;

const citySelect = document.getElementById("city-select");
const temperatureDate = document.getElementById("temperature-date");
const observationTime = document.getElementById("observation-time");
const balloonMetricTabs = [...document.querySelectorAll("[data-balloon-metric]")];
let selectedBalloonMetric = "temperature";
const status = document.getElementById("status");
const emptyState = document.getElementById("empty-state");
const stationDetails = document.getElementById("station-details");
const osmCategoryDescriptions = {
  allotments: "Land divided into individual plots for growing vegetables, fruit or flowers, usually rented or assigned to households. Not necessarily publicly accessible.",
  community_garden: "A garden cultivated collectively by a local community, often for food growing, education or shared recreation.",
  park: "A managed green space for recreation, usually with paths, lawns, trees or planted areas.",
  green_roof: "A building roof covered partly or fully with vegetation. The mapped building or roof outline may be larger than the vegetated area.",
  green_roof_tag: "A roof tagged as vegetated in OpenStreetMap. The mapped outline is not necessarily the exact planted area.",
  green_wall: "Vegetation growing on or supported by a building facade. A mapped building outline does not necessarily describe the wall's exact extent.",
  grass_area: "An area tagged landuse=grass, often maintained grass or lawn. It may include roadside verges, but the tag alone does not confirm its location or nature-based-solution value.",
  rain_garden: "A planted depression designed to collect runoff and let stormwater soak into the soil.",
  stormwater_basin: "An engineered basin for holding or managing water. Its tags must be checked to establish its purpose and whether it is vegetated.",
  retention_basin: "A basin tagged for retention, detention or infiltration of runoff, helping store water or slow its release.",
  swale: "A shallow drainage channel that conveys runoff and may help infiltration. Vegetation is not guaranteed by the tag alone.",
  water_reservoir: "An artificial water-storage body, such as a supply or treatment reservoir. It is not automatically a nature-based solution.",
  water_pond: "A small standing body of water, which may be natural or artificial. A pond tag alone does not establish a stormwater function.",
  water_basin: "A mapped water surface in an artificial basin. Its function and ecological design require checking the source tags.",
  water_wastewater: "A water surface used for wastewater storage or treatment. It is not automatically a nature-based solution.",
  wastewater_plant: "A facility treating wastewater. Its boundary may include buildings, tanks and ponds, not just nature-based treatment areas.",
  wetland: "Land that is permanently or seasonally saturated with water, such as marsh, swamp or reedbed. It is not necessarily an implemented project.",
};

async function selectView(view) {
  selectedView = view;
  const weather = view !== "nbs";
  const nbs = view !== "weather";
  document.getElementById("weather-controls").hidden = !weather;
  document.getElementById("weather-details").hidden = !weather;
  document.getElementById("nbs-options").hidden = !nbs;
  for (const selector of [".map-key", ".temperature-legend"]) {
    const element = document.querySelector(selector);
    if (element) element.hidden = !weather;
  }
  for (const layer of [stationLayer, metStationLayer, ecadStationLayer]) {
    if (weather) layer.addTo(map);
    else map.removeLayer(layer);
  }
  if (nbs) nbsLayer.addTo(map);
  else map.removeLayer(nbsLayer);
  nbsLoadController?.abort();
  if (!weather) cityLoadController?.abort();
  status.textContent = weather ? "Netatmo / weather view"
    : selectedCity ? `NbS — ${displayRegion(selectedCity)}` : "Select a city to load NbS";
  if (weather && selectedCity) await loadCity(selectedCity, false);
  else if (nbs && selectedCity && nbsPayload?.city !== selectedCity) await loadNbs();
}

function osmCategoryOptions(features, categoryColors = {}) {
  const container = document.getElementById("nbs-osm-categories");
  const previous = new Map([...container.querySelectorAll("input")].map(input => [input.value, input.checked]));
  const counts = new Map([["green_wall", 0]]);
  for (const feature of features) {
    for (const category of feature.properties.categories) {
      counts.set(category, (counts.get(category) || 0) + 1);
    }
  }
  container.replaceChildren();
  for (const [category, count] of [...counts].sort(([a], [b]) => a.localeCompare(b))) {
    const option = document.createElement("label");
    option.className = "nbs-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = category;
    input.checked = previous.get(category) ?? true;
    input.disabled = count === 0;
    input.addEventListener("change", renderNbs);
    const swatch = document.createElement("span");
    swatch.className = "nbs-swatch";
    swatch.style.background = categoryColors[category]
      || features.find(feature => feature.properties.categories.includes(category))?.properties.color
      || "#9e5e30";
    const text = document.createElement("span");
    text.textContent = `${label(category)} (${count})`;
    input.setAttribute("aria-label", text.textContent);
    if (osmCategoryDescriptions[category]) {
      text.className = "nbs-category-text";
      text.tabIndex = 0;
      const description = document.createElement("span");
      description.id = `nbs-description-${category}`;
      description.className = "nbs-category-tooltip";
      description.setAttribute("role", "tooltip");
      description.textContent = osmCategoryDescriptions[category];
      text.setAttribute("aria-describedby", description.id);
      text.appendChild(description);
    }
    option.append(input, swatch, text);
    container.appendChild(option);
  }
}

function renderNbs() {
  if (!nbsPayload) return;
  nbsLayer.clearLayers();
  const osmCategories = new Set([...document.querySelectorAll("#nbs-osm-categories input:checked")].map(input => input.value));
  const climateVisible = document.getElementById("climatescan-visible").checked;
  const nearbyOsmIds = new Set(nbsPayload.climatescan.features.flatMap(
    feature => feature.properties.nearby_osm.map(match => match.osm_id),
  ));
  const highlightOsm = document.getElementById("osm-nearby").checked;
  document.getElementById("osm-nearby-count").textContent = nearbyOsmIds.size;
  const osmStyle = (feature) => {
    const nearby = highlightOsm && nearbyOsmIds.has(feature.properties.osm_id);
    const category = feature.properties.categories.find(value => osmCategories.has(value));
    const categoryColor = nbsPayload.category_colors?.[category] || feature.properties.color;
    return {
      color: nearby ? "#c026d3" : categoryColor,
      fillColor: categoryColor, weight: nearby ? 4 : 2,
      dashArray: nearby ? "6 3" : null, fillOpacity: 0.25,
    };
  };
  const attach = (feature, layer) => {
    layer.bindPopup(feature.properties.popup_html, { maxWidth: 450 });
    const nearby = nearbyOsmIds.has(feature.properties.osm_id)
      ? "<br>Within 150 m of ClimateScan (candidate)" : "";
    layer.bindTooltip(escapeHtml(feature.properties.name || feature.properties.osm_id) + nearby, { sticky: true });
  };
  L.geoJSON(nbsPayload.osm, {
    pane: "nbs-areas",
    filter: feature => feature.properties.categories.some(category => osmCategories.has(category)),
    style: osmStyle,
    pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
      ...osmStyle(feature), pane: "nbs-points", radius: 5, fillOpacity: 0.8,
    }),
    onEachFeature: attach,
  }).addTo(nbsLayer);
  const balloon = (feature, latlng) => L.marker(latlng, {
    pane: "nbs-points", title: feature.properties.name,
    icon: L.divIcon({
      className: "climatescan-balloon-icon",
      html: '<span class="climatescan-balloon"></span>',
      iconSize: [26, 32], iconAnchor: [13, 30], popupAnchor: [0, -27],
    }),
  });
  const geometryBalloons = [];
  const climateLayer = L.geoJSON(nbsPayload.climatescan, {
    pane: "nbs-areas",
    filter: () => climateVisible,
    style: () => ({ color: "#8b5a2b", weight: 4, fillOpacity: 0.2 }),
    pointToLayer: balloon,
    onEachFeature: (feature, layer) => {
      attach(feature, layer);
      if (["Polygon", "MultiPolygon", "GeometryCollection"].includes(feature.geometry.type)) {
        const marker = balloon(feature, layer.getBounds().getCenter());
        attach(feature, marker);
        geometryBalloons.push(marker);
      }
    },
  });
  geometryBalloons.forEach(marker => marker.addTo(climateLayer));
  climateLayer.addTo(nbsLayer);
  L.geoJSON(nbsPayload.boundary, {
    pane: "nbs-areas", interactive: false,
    style: { color: "#475569", weight: 2, fillOpacity: 0 },
  }).addTo(nbsLayer);
}

async function loadNbs() {
  nbsLoadController?.abort();
  const city = selectedCity;
  if (!city) {
    document.getElementById("nbs-message").textContent = "Select a city to load NbS";
    return;
  }
  const controller = new AbortController();
  nbsLoadController = controller;
  nbsPayload = null;
  nbsLayer.clearLayers();
  const message = document.getElementById("nbs-message");
  message.textContent = `Loading ${displayRegion(city)} NbS layers…`;
  try {
    const payload = await getJSON(`/api/nbs?city=${encodeURIComponent(city)}`, controller.signal);
    controller.signal.throwIfAborted();
    if (payload.city !== city) throw new Error("NbS response does not match the selected city");
    osmCategoryOptions(payload.osm.features, payload.category_colors);
    nbsPayload = payload;
    renderNbs();
    message.textContent = `${displayRegion(city)}: ${payload.osm.features.length} OSM features · ${payload.climatescan.features.length} ClimateScan records`;
    if (selectedView === "nbs") status.textContent = message.textContent;
  } catch (error) {
    if (controller.signal.aborted) return;
    nbsPayload = null;
    nbsLayer.clearLayers();
    message.textContent = `Could not load NbS layers: ${error.message}`;
    if (selectedView === "nbs") status.textContent = message.textContent;
  }
}

const ylOrBr = ["#ffffe5", "#fff7bc", "#fee391", "#fec44f", "#fe9929", "#ec7014", "#cc4c02", "#993404", "#662506"];
const humidityPalette = ["#eff6ff", "#dbeafe", "#bfdbfe", "#93c5fd", "#60a5fa", "#3b82f6", "#1d4ed8", "#1e40af", "#172554"];
const pressurePalette = ["#f5f3ff", "#ede9fe", "#ddd6fe", "#c4b5fd", "#a78bfa", "#8b5cf6", "#7c3aed", "#6d28d9", "#4c1d95"];
const balloonMetrics = {
  temperature: { label: "Netatmo temperature", unit: "°C", field: "selected_temperature_c", palette: ylOrBr, format: formatTemp },
  humidity: { label: "Netatmo humidity", unit: "%", field: "selected_humidity", palette: humidityPalette, format: formatHumidity },
  pressure: { label: "Netatmo pressure", unit: "mb", field: "selected_pressure_hpa", palette: pressurePalette, format: (value) => Number.isFinite(value) ? `${value.toFixed(1)} mb` : "No pressure" },
};
const STATIC_DATA = typeof window !== "undefined" && window.DASHBOARD_STATIC_DATA === true;
const staticCityCache = new Map();
let staticCitiesPromise = null;
let staticManifestPromise = null;
const temperatureLegend = L.control({ position: "bottomright" });
temperatureLegend.onAdd = () => {
  const div = L.DomUtil.create("div", "temperature-legend");
  div.innerHTML = `<div class="legend-title">Daily mean temperature</div><div class="legend-gradient"></div><div class="legend-labels"><span>—</span><span>—</span></div><div class="legend-count"></div>`;
  return div;
};
temperatureLegend.addTo(map);

function updateLegend(date, minimum, maximum, count, metric = "temperature") {
  const element = document.querySelector(".temperature-legend");
  if (!element) return;
  const metricConfig = balloonMetrics[metric] || balloonMetrics.temperature;
  const gradient = element.querySelector(".legend-gradient");
  const labels = element.querySelector(".legend-labels");
  const countLabel = element.querySelector(".legend-count");
  element.querySelector(".legend-title").textContent = date ? `${metricConfig.label} · ${date}` : metricConfig.label;
  if (Number.isFinite(minimum) && Number.isFinite(maximum)) {
    gradient.style.background = `linear-gradient(to right, ${metricConfig.palette.join(", ")})`;
    labels.innerHTML = `<span>${formatMapValue(minimum, metricConfig)}</span><span>${formatMapValue(maximum, metricConfig)}</span>`;
    countLabel.textContent = `${count} stations with data`;
  } else {
    gradient.style.background = "#cbd5e1";
    labels.innerHTML = "<span>No data</span><span></span>";
    countLabel.textContent = `No ${metricConfig.label.toLowerCase()} data for this date`;
  }
}

function formatMapValue(value, metricConfig) {
  if (!Number.isFinite(value)) return "—";
  const precision = metricConfig === balloonMetrics.humidity ? 0 : 1;
  return `${value.toFixed(precision)} ${metricConfig.unit}`;
}

function interpolateColor(value, minimum, maximum, palette = ylOrBr) {
  if (!Number.isFinite(value) || !Number.isFinite(minimum) || !Number.isFinite(maximum)) return "#94a3b8";
  const fraction = minimum === maximum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const position = fraction * (palette.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(palette.length - 1, lower + 1);
  const mix = position - lower;
  const rgb = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const low = rgb(palette[lower]);
  const high = rgb(palette[upper]);
  return `rgb(${low.map((channel, index) => Math.round(channel + (high[index] - channel) * mix)).join(",")})`;
}

function label(text) {
  return String(text || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function displayRegion(city) {
  return city.startsWith("fua_") ? `${label(city.replace(/^fua_/, ""))} FUA` : label(city);
}

function formatTemp(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} °C` : "No temperature";
}

function formatHumidity(value) {
  return Number.isFinite(value) ? `${value.toFixed(0)} %` : "No humidity";
}

function formatPressure(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)} hPa` : "No pressure";
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "No timestamp";
}

function sourceLabel(source) {
  return source === "met" ? "Meteorological station" : source === "ecad" ? "ECAD station" : source === "fua" ? "FUA Netatmo station" : "Netatmo station";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;",
  }[character]));
}

function chooseStation(city, selected) {
  const selectedPoint = map.latLngToLayerPoint([selected.station.lat, selected.station.lon]);
  const overlapping = activeStations.filter(({ station }) => {
    const point = map.latLngToLayerPoint([station.lat, station.lon]);
    return selectedPoint.distanceTo(point) <= 24;
  });
  if (overlapping.length < 2) {
    loadStation(city, selected.station.station_id, selected.source);
    return;
  }

  const content = document.createElement("div");
  content.className = "station-chooser";
  const heading = document.createElement("strong");
  heading.textContent = `${overlapping.length} overlapping stations`;
  content.appendChild(heading);
  const hint = document.createElement("span");
  hint.textContent = "Choose a station to see its details:";
  content.appendChild(hint);
  for (const item of overlapping) {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `${escapeHtml(sourceLabel(item.source))} · ${escapeHtml(item.station.station_name)}<small>${escapeHtml(formatTemp(item.station.selected_temperature_c))}</small>`;
    button.addEventListener("click", () => {
      map.closePopup();
      loadStation(city, item.station.station_id, item.source);
    });
    content.appendChild(button);
  }
  L.popup({ maxWidth: 360 })
    .setLatLng([selected.station.lat, selected.station.lon])
    .setContent(content)
    .openOn(map);
}

function stationColor(value) {
  if (!Number.isFinite(value)) return "#94a3b8";
  if (value < 0) return "#2563eb";
  if (value < 10) return "#38bdf8";
  if (value < 20) return "#f59e0b";
  return "#dc2626";
}

async function getJSON(url, signal) {
  if (STATIC_DATA) return getStaticJSON(url, signal);
  const started = Date.now();
  const requestURL = new URL(url, location.href);
  while (true) {
    const response = await fetch(requestURL, { cache: "no-store", signal });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
    if (response.status !== 202) return payload;
    signal?.throwIfAborted();
    const elapsed = Math.round((Date.now() - started) / 1000);
    status.textContent = `${payload.message}. First-time indexing can take a few minutes (${elapsed}s).`;
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 1000);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    requestURL.searchParams.set("refresh", "0");
  }
}

async function fetchStaticJSON(path, signal) {
  const baseURL = typeof document.baseURI === "string" ? document.baseURI : location.href;
  const response = await fetch(new URL(`data/${path}`, baseURL), { signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

async function staticCityData(city, signal) {
  if (!staticCityCache.has(city)) {
    const request = fetchStaticJSON(`weather/${encodeURIComponent(city)}.json`, signal)
      .catch(error => {
        staticCityCache.delete(city);
        throw error;
      });
    staticCityCache.set(city, request);
  }
  return staticCityCache.get(city);
}

async function staticManifest(signal) {
  if (!staticManifestPromise) {
    staticManifestPromise = fetchStaticJSON("manifest.json", signal)
      .catch(error => {
        staticManifestPromise = null;
        throw error;
      });
  }
  return staticManifestPromise;
}

function staticMapPayload(data, source, requestedDate) {
  const sourceData = data.sources[source];
  if (!sourceData) throw new Error(`No ${source} snapshot is available for ${data.city}`);
  const selectedDate = requestedDate || sourceData.max_date;
  let stationsWithData = 0;
  const stations = sourceData.stations.map(station => {
    const values = station.values.find(row => row[0] === selectedDate);
    const selectedTemperature = values?.[1] ?? null;
    if (Number.isFinite(selectedTemperature)) stationsWithData++;
    return {
      station_id: station.station_id,
      station_name: station.station_name,
      lat: station.lat,
      lon: station.lon,
      height_m: station.height_m,
      latest_time: station.latest_time,
      latest_temperature_c: station.latest_temperature_c,
      latest_humidity: station.latest_humidity,
      latest_pressure_hpa: station.latest_pressure_hpa,
      selected_temperature_c: selectedTemperature,
      selected_humidity: values?.[2] ?? null,
      selected_pressure_hpa: values?.[3] ?? null,
      selected_observation_time: null,
    };
  });
  return {
    city: data.city,
    stations,
    selected_date: selectedDate,
    selected_time: null,
    min_date: sourceData.min_date,
    max_date: sourceData.max_date,
    stations_with_data: stationsWithData,
  };
}

function staticSeries(rows, fieldIndex) {
  const points = rows
    .filter(row => Number.isFinite(row[fieldIndex]))
    .map(row => ({ x: row[0], y: row[fieldIndex] }));
  return { x: points.map(point => point.x), y: points.map(point => point.y) };
}

function staticPeriodSeries(rows, periodLength) {
  const groups = new Map();
  for (const row of rows) {
    if (!Number.isFinite(row[1])) continue;
    const key = row[0].slice(0, periodLength);
    const values = groups.get(key) || [];
    values.push(row[1]);
    groups.set(key, values);
  }
  const keys = [...groups.keys()].sort();
  return {
    x: keys,
    y: keys.map(key => {
      const values = groups.get(key);
      return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
    }),
  };
}

async function getStaticJSON(url, signal) {
  const requestURL = new URL(url, location.href);
  if (requestURL.pathname.endsWith("/api/cities")) {
    if (!staticCitiesPromise) {
      staticCitiesPromise = fetchStaticJSON("cities.json", signal)
        .catch(error => {
          staticCitiesPromise = null;
          throw error;
        });
    }
    return staticCitiesPromise;
  }
  if (requestURL.pathname.endsWith("/api/nbs")) {
    const city = requestURL.searchParams.get("city") || "lund";
    const manifest = await staticManifest(signal);
    if (!manifest.nbs_cities.includes(city)) {
      throw new Error(`NbS data are not available for ${city}. Available cities: ${manifest.nbs_cities.join(", ")}.`);
    }
    return fetchStaticJSON(`nbs/${encodeURIComponent(city)}.json`, signal);
  }
  const mapRoute = requestURL.pathname.match(/\/api\/(stations|met-stations|ecad-stations)$/);
  if (mapRoute) {
    const city = requestURL.searchParams.get("city") || "";
    const source = mapRoute[1] === "stations" ? "netatmo"
      : mapRoute[1] === "met-stations" ? "met" : "ecad";
    const data = await staticCityData(city, signal);
    return staticMapPayload(data, source, requestURL.searchParams.get("date"));
  }
  if (requestURL.pathname.endsWith("/api/station")) {
    const city = requestURL.searchParams.get("city") || "";
    const stationId = requestURL.searchParams.get("station_id") || "";
    const sourceName = requestURL.searchParams.get("source") || "netatmo";
    const source = sourceName === "met" || sourceName === "ecad" ? sourceName : "netatmo";
    const data = await staticCityData(city, signal);
    const stationData = data.sources[source]?.stations.find(item => item.station_id === stationId);
    if (!stationData) throw new Error(`Unknown station in ${city}: ${stationId}`);
    const rows = stationData.values;
    const temperature = staticSeries(rows, 1);
    const humidity = staticSeries(rows, 2);
    const pressure = staticSeries(rows, 3);
    const first = rows[0]?.[0] || null;
    const last = rows.at(-1)?.[0] || null;
    return {
      city,
      station: {
        station_id: stationData.station_id,
        station_name: stationData.station_name,
        lat: stationData.lat,
        lon: stationData.lon,
        height_m: stationData.height_m,
        latest_time: stationData.latest_time || (last ? `${last}T00:00:00` : null),
        latest_temperature_c: stationData.latest_temperature_c,
        latest_humidity: stationData.latest_humidity,
        latest_pressure_hpa: stationData.latest_pressure_hpa,
      },
      observations: stationData.observations || { count: rows.length, first, last },
      temperature,
      daily: temperature,
      monthly: staticPeriodSeries(rows, 7),
      annual: staticPeriodSeries(rows, 4),
      humidity,
      pressure,
    };
  }
  throw new Error(`Unsupported static data request: ${requestURL.pathname}`);
}

function cityStyle(feature) {
  const color = feature.properties.region_type === "fua" ? "#7c3aed"
    : feature.properties.country === "Norway" ? norwayBoundaryColor : otherBoundaryColor;
  return { color, weight: feature.properties.region_type === "fua" ? 2.5 : 2,
    dashArray: feature.properties.region_type === "fua" ? "6 4" : null,
    fillColor: color, fillOpacity: feature.properties.region_type === "fua" ? 0.06 : 0.1 };
}

function attachCity(feature, layer) {
  const { city, label: cityLabel, station_count: count, met_station_count: metCount } = feature.properties;
  citiesByName.set(city, layer);
  const ecadCount = feature.properties.ecad_station_count || 0;
  const metLabel = Number.isFinite(metCount) ? `${metCount} meteorological` : "meteorological";
  layer.bindTooltip(`${cityLabel} · ${count} Netatmo · ${metLabel} · ${ecadCount} ECAD`, { sticky: true });
  layer.on({
    mouseover: () => layer.setStyle({ weight: 4, fillOpacity: 0.24 }),
    mouseout: () => layer.setStyle(cityStyle(feature)),
    click: () => loadCity(city, true),
  });
}

async function loadCity(city, zoom) {
  cityLoadController?.abort();
  const controller = new AbortController();
  cityLoadController = controller;
  const { signal } = controller;
  const changedCity = city !== selectedCity;
  selectedCity = city;
  if (changedCity) {
    nbsLoadController?.abort();
    nbsPayload = null;
    nbsLayer.clearLayers();
    selectedStation = null;
    selectedStationSource = "netatmo";
    stationDetails.hidden = true;
    emptyState.hidden = false;
  }
  citySelect.value = city;
  stationLayer.clearLayers();
  metStationLayer.clearLayers();
  ecadStationLayer.clearLayers();
  map.closePopup();
  activeStations = [];
  if (zoom && citiesByName.has(city)) map.fitBounds(citiesByName.get(city).getBounds(), { padding: [22, 22], maxZoom: 11 });
  const nbsRequest = selectedView !== "weather" && nbsPayload?.city !== city ? loadNbs() : null;
  if (selectedView === "nbs") {
    await nbsRequest;
    return;
  }
  status.textContent = `Loading ${displayRegion(city)} stations…`;
  try {
    const cityQuery = encodeURIComponent(city);
    const requestedHour = observationTime.value || null;
    const requestedDate = temperatureDate.value || null;
    const requestedTime = requestedHour && requestedDate ? `${requestedDate}T${requestedHour}` : null;
    const netatmoQuery = requestedTime
      ? `&time=${encodeURIComponent(requestedTime)}`
      : requestedDate ? `&date=${encodeURIComponent(requestedDate)}` : "";
    const otherQuery = requestedDate ? `&date=${encodeURIComponent(requestedDate)}` : "";
    let [netatmo, meteorological, ecad] = await Promise.all([
      getJSON(`/api/stations?city=${cityQuery}${netatmoQuery}`, signal),
      getJSON(`/api/met-stations?city=${cityQuery}${otherQuery}`, signal),
      getJSON(`/api/ecad-stations?city=${cityQuery}${otherQuery}`, signal),
    ]);
    let selectedDate = requestedDate || [netatmo.max_date, meteorological.max_date, ecad.max_date].filter(Boolean).sort().pop();
    if (!requestedTime && selectedDate && (netatmo.selected_date !== selectedDate || meteorological.selected_date !== selectedDate || ecad.selected_date !== selectedDate)) {
      const selectedQuery = `&date=${encodeURIComponent(selectedDate)}&refresh=0`;
      [netatmo, meteorological, ecad] = await Promise.all([
        getJSON(`/api/stations?city=${cityQuery}${selectedQuery}`, signal),
        getJSON(`/api/met-stations?city=${cityQuery}${selectedQuery}`, signal),
        getJSON(`/api/ecad-stations?city=${cityQuery}${selectedQuery}`, signal),
      ]);
    }
    signal.throwIfAborted();
    selectedDate = requestedDate || netatmo.selected_date || meteorological.selected_date || ecad.selected_date || selectedDate;
    if (selectedDate) temperatureDate.value = selectedDate;
    const minDates = [netatmo.min_date, meteorological.min_date, ecad.min_date].filter(Boolean).sort();
    const maxDates = [netatmo.max_date, meteorological.max_date, ecad.max_date].filter(Boolean).sort();
    if (minDates.length) temperatureDate.min = minDates[0];
    if (maxDates.length) temperatureDate.max = maxDates[maxDates.length - 1];
    const selectedTime = requestedTime ? (netatmo.selected_time || requestedTime) : null;
    const allStations = [
      ...netatmo.stations.map((station) => ({ station, source: city.startsWith("fua_") ? "fua" : "netatmo" })),
      ...meteorological.stations.map((station) => ({ station, source: "met" })),
      ...ecad.stations.map((station) => ({ station, source: "ecad" })),
    ];
    activeStations = allStations;
    const temperatureValues = allStations.map(({ station }) => station.selected_temperature_c).filter(Number.isFinite);
    const temperatureMinimum = temperatureValues.length ? Math.min(...temperatureValues) : null;
    const temperatureMaximum = temperatureValues.length ? Math.max(...temperatureValues) : null;
    const metric = balloonMetrics[selectedBalloonMetric] || balloonMetrics.temperature;
    const balloonValues = netatmo.stations.map((station) => station[metric.field]).filter(Number.isFinite);
    const balloonMinimum = balloonValues.length ? Math.min(...balloonValues) : null;
    const balloonMaximum = balloonValues.length ? Math.max(...balloonValues) : null;
    updateLegend(selectedDate, balloonMinimum, balloonMaximum, balloonValues.length, selectedBalloonMetric);
    for (const { station, source } of allStations) {
      const value = station.selected_temperature_c;
      const temperatureColor = interpolateColor(value, temperatureMinimum, temperatureMaximum, ylOrBr);
      if (source === "met") {
        const marker = L.marker([station.lat, station.lon], {
          icon: L.divIcon({
            className: "met-station-icon",
            html: `<span class="met-station-square" style="background:${temperatureColor}"></span>`,
            iconSize: [20, 20], iconAnchor: [10, 10],
          }),
        });
        marker.bindTooltip(`Meteorological station: ${station.station_name}<br>${selectedDate || "Selected date"}: ${formatTemp(value)}<br>Latest: ${formatTemp(station.latest_temperature_c)}`, { direction: "top" });
        marker.on("click", () => chooseStation(city, { station, source }));
        marker.addTo(metStationLayer);
      } else if (source === "ecad") {
        const marker = L.marker([station.lat, station.lon], {
          icon: L.divIcon({
            className: "ecad-station-icon",
            html: `<span class="ecad-station-triangle" style="--marker-color:${temperatureColor}"></span>`,
            iconSize: [28, 28], iconAnchor: [14, 14],
          }),
        });
        marker.bindTooltip(`ECAD station: ${station.station_name}<br>${selectedDate || "Selected date"}: ${formatTemp(value)}<br>Latest: ${formatTemp(station.latest_temperature_c)}`, { direction: "top" });
        marker.on("click", () => chooseStation(city, { station, source }));
        marker.addTo(ecadStationLayer);
      } else {
        const balloonValue = station[metric.field];
        const balloonColor = interpolateColor(balloonValue, balloonMinimum, balloonMaximum, metric.palette);
        const marker = L.marker([station.lat, station.lon], {
          icon: L.divIcon({
            className: "netatmo-balloon-icon",
            html: `<span class="netatmo-balloon" style="background:${balloonColor}"></span>`,
            iconSize: [21, 21], iconAnchor: [10, 20],
          }),
        });
        const observationLabel = selectedTime && station.selected_observation_time
          ? formatTime(station.selected_observation_time)
          : selectedDate || "Selected date";
        marker.bindTooltip(`${station.station_name}<br>${observationLabel}: ${metric.format(balloonValue)}<br>Temperature: ${formatTemp(value)}<br>Latest: ${formatTemp(station.latest_temperature_c)}`, { direction: "top" });
        marker.on("click", () => chooseStation(city, { station, source }));
        marker.addTo(stationLayer);
      }
    }
    status.textContent = `${displayRegion(city)}: ${netatmo.stations_with_data} of ${netatmo.stations.length} Netatmo, ${meteorological.stations_with_data} of ${meteorological.stations.length} meteorological, and ${ecad.stations_with_data} of ${ecad.stations.length} ECAD stations have data on ${selectedDate || "the selected date"}.`;
  } catch (error) {
    if (signal.aborted) return;
    controller.abort();
    status.textContent = `Could not load ${displayRegion(city)}: ${error.message}`;
  }
  await nbsRequest;
}

function chart(target, title, data, xTitle, unit = "°C", color = "#0f766e", compact = false) {
  const x = Array.isArray(data?.x) ? data.x : [];
  const y = Array.isArray(data?.y) ? data.y : [];
  const points = x.map((value, index) => ({ x: value, y: Number(y[index]) }))
    .filter((point) => point.x && Number.isFinite(point.y));
  const yValues = points.map((point) => point.y);
  const yMinimum = yValues.length ? Math.min(...yValues) : null;
  const yMaximum = yValues.length ? Math.max(...yValues) : null;
  const yPadding = yMinimum === null ? null : yMinimum === yMaximum
    ? Math.max(Math.abs(yMinimum) * 0.05, 0.5)
    : Math.max((yMaximum - yMinimum) * 0.12, 0.1);
  const yAxis = {
    title: { text: unit, font: { size: compact ? 9 : 12 } },
    tickfont: { size: compact ? 8 : 10 },
    zeroline: true,
    autorange: yPadding === null,
  };
  if (yPadding !== null) yAxis.range = [yMinimum - yPadding, yMaximum + yPadding];
  Plotly.react(target, [{ x: points.map((point) => point.x), y: points.map((point) => point.y), mode: "lines+markers", line: { color, width: compact ? 2.5 : 2, shape: "linear" }, marker: { size: compact ? 4.5 : 5, color, line: { color: "white", width: 1 } }, connectgaps: false, hovertemplate: `%{x}<br>%{y:.1f} ${unit}<extra></extra>` }], {
    margin: { t: compact ? 31 : 12, r: 4, b: compact ? 4 : 42, l: compact ? 34 : 46 },
    title: title ? { text: title, font: { size: 12 } } : undefined,
    xaxis: { title: compact ? "" : xTitle, side: compact ? "top" : "bottom", showticklabels: true, tickmode: "auto", ticks: "outside", ticklen: compact ? 6 : 4, tickwidth: 1, tickcolor: "#111827", showline: true, linecolor: "#cbd5e1", tickfont: { size: compact ? 8 : 10 }, type: compact ? "date" : undefined, autorange: true, automargin: true, showgrid: !compact },
    yaxis: yAxis,
    paper_bgcolor: "white", plot_bgcolor: "#f8fafc", showlegend: false,
    height: compact ? 108 : 230,
  }, { responsive: true, displayModeBar: false });
}

function metric(name, value) {
  return `<div class="metric"><span>${name}</span><strong>${value}</strong></div>`;
}

async function loadStation(city, stationId, source = "netatmo") {
  selectedStation = stationId;
  selectedStationSource = source;
  status.textContent = `Loading station ${stationId}…`;
  try {
    const payload = await getJSON(`/api/station?city=${encodeURIComponent(city)}&station_id=${encodeURIComponent(stationId)}&source=${source}`);
    if (selectedView === "nbs") return;
    const station = payload.station;
    emptyState.hidden = true;
    stationDetails.hidden = false;
    document.getElementById("station-title").textContent = station.station_name || sourceLabel(source);
    document.getElementById("station-meta").textContent = `${sourceLabel(source)} · ${displayRegion(payload.city)} · ${station.station_id}`;
    document.getElementById("summary").innerHTML = [
      ...(!["netatmo", "fua"].includes(source) ? [metric("Latest temperature", formatTemp(station.latest_temperature_c))] : []),
      metric("Latest observation", formatTime(station.latest_time)),
      metric("Observations", payload.observations.count.toLocaleString()),
      metric("Coverage", `${payload.observations.first ? payload.observations.first.slice(0, 10) : "—"} to ${payload.observations.last ? payload.observations.last.slice(0, 10) : "—"}`),
    ].join("");
    chart("daily-chart", "Mean temperature by day", payload.daily, "Date");
    chart("monthly-chart", "Mean temperature by calendar month", payload.monthly, "Month");
    const weatherPlots = document.getElementById("weather-plots");
    weatherPlots.hidden = !["netatmo", "fua"].includes(source);
    if (["netatmo", "fua"].includes(source)) {
      const usableSeries = (...series) => series.find((item) => Array.isArray(item?.x) && item.x.length && Array.isArray(item?.y) && item.y.length) || { x: [], y: [] };
      document.getElementById("temperature-latest").textContent = formatTemp(station.latest_temperature_c);
      document.getElementById("humidity-latest").textContent = formatHumidity(station.latest_humidity);
      document.getElementById("pressure-latest").textContent = formatPressure(station.latest_pressure_hpa).replace("hPa", "mb");
      chart("temperature-chart", "", usableSeries(payload.temperature), "Time", "°C", "#3b73ff", true);
      chart("humidity-chart", "", usableSeries(payload.humidity), "Time", "%", "#3b73ff", true);
      chart("pressure-chart", "", usableSeries(payload.pressure), "Time", "mb", "#3b73ff", true);
    }
    status.textContent = `Showing ${station.station_id}. Data are read live from its CSV file.`;
  } catch (error) {
    if (selectedView === "nbs") return;
    status.textContent = `Could not load station: ${error.message}`;
  }
}

async function refresh() {
  if (selectedView === "nbs") return;
  if (selectedCity) await loadCity(selectedCity, false);
  if (selectedCity && selectedStation) await loadStation(selectedCity, selectedStation, selectedStationSource);
}

async function setup() {
  if (STATIC_DATA) {
    document.body.classList.add("static-snapshot");
    const note = document.getElementById("snapshot-note");
    if (note) note.hidden = false;
  }
  document.getElementById("view-select").addEventListener("change", (event) => selectView(event.target.value));
  document.getElementById("nbs-reload").addEventListener("click", loadNbs);
  document.getElementById("climatescan-visible").addEventListener("change", renderNbs);
  document.getElementById("osm-nearby").addEventListener("change", renderNbs);
  try {
    const cities = await getJSON("/api/cities");
    L.geoJSON(cities, { style: cityStyle, onEachFeature: attachCity }).addTo(map);
    citySelect.innerHTML = "";
    const entries = cities.features.map((feature) => feature.properties).sort((a, b) => a.label.localeCompare(b.label));
    for (const city of entries) {
      const option = document.createElement("option");
      option.value = city.city;
      option.textContent = city.label;
      citySelect.appendChild(option);
    }
    citySelect.addEventListener("change", (event) => loadCity(event.target.value, true));
    balloonMetricTabs.forEach((tab) => tab.addEventListener("click", () => {
      selectedBalloonMetric = tab.dataset.balloonMetric || "temperature";
      balloonMetricTabs.forEach((item) => {
        const active = item === tab;
        item.classList.toggle("active", active);
        item.setAttribute("aria-selected", String(active));
      });
      if (selectedCity) loadCity(selectedCity, false);
    }));
    temperatureDate.addEventListener("change", () => {
      if (selectedCity) loadCity(selectedCity, false);
    });
    observationTime.addEventListener("change", () => {
      if (selectedCity) loadCity(selectedCity, false);
    });
    document.getElementById("latest-date").addEventListener("click", () => {
      temperatureDate.value = "";
      observationTime.value = "";
      if (selectedCity) loadCity(selectedCity, false);
    });
    document.getElementById("study-region").addEventListener("click", () => map.fitBounds(studyBounds));
    document.getElementById("refresh").addEventListener("click", refresh);
    document.getElementById("close-details").addEventListener("click", () => {
      stationDetails.hidden = true; emptyState.hidden = false; selectedStation = null; selectedStationSource = "netatmo";
    });
    const initial = entries.find((city) => city.city === "oslo") || entries.find((city) => city.region_type === "fua") || entries[0];
    if (initial) await loadCity(initial.city, true);
  } catch (error) {
    status.textContent = `Could not initialise map: ${error.message}`;
  }
}

setup();
if (!STATIC_DATA) setInterval(refresh, 5 * 60 * 1000);
