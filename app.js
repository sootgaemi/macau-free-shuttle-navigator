const GOOGLE_MAPS_API_KEY = "AIzaSyCMgyObHOwYjCGUcnJbKV7yiy3P22IAbA0";

const SETTINGS = {
  MAX_RESULTS: 2,
  WALKING_FALLBACK_KMH: 4.5,
  HOTEL_DEST_RADIUS_M: 700,
  DROP_CLOSER_MARGIN_M: 200,
  MAX_LAST_WALK_M: 1500,
  DIRECT_WALK_PRIORITY_M: 1200,
  HOTEL_FINAL_WALK_IGNORE_M: 120,
};

const MACAU_BOUNDS = {
  north: 22.2305,
  south: 22.1060,
  east: 113.6115,
  west: 113.5285,
};

const HOTEL_ALIASES = {
  "Galaxy Macau": ["galaxy", "galaxy hotel", "galaxy macau", "galaxy hotel macau"],
  "The Venetian Macao": ["venetian", "venetian macao", "the venetian", "the venetian macao"],
  "The Parisian Macao": ["parisian", "parisian macao", "the parisian", "the parisian macao"],
  "Studio City Macau": ["studio city", "studio city macau", "studio city hotel", "스튜디오 시티", "스튜디오시티"],
  "The Londoner Macao": ["londoner", "the londoner", "the londoner macao", "londoner macao"],
  "MGM Macau": ["mgm", "mgm macau"],
  "Wynn Macau": ["wynn", "wynn macau"],
  "Grand Lisboa": ["grand lisboa", "grand lisboa macau", "그랜드 리스보아", "그랜드리스보아"],
  "Hotel Lisboa": ["hotel lisboa", "리스보아 호텔", "호텔 리스보아"],
};

let map;
let appData = null;
let currentPlace = null;
let destinationPlace = null;
let routeOverlays = [];
let mapMarkers = [];
let latestResults = [];
let selectedRouteIndex = 0;

let currentAutocomplete = null;
let destinationAutocomplete = null;
let isSearching = false;
let mapPickMode = null;
let currentMode = "shuttle";

let latestSearchContext = {
  nearHotelNotice: "",
  targetHotelName: "",
  targetHotelByNearby: false,
  directWalk: null,
};

let sheetState = "mid";

async function loadJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${path} 파일을 불러오지 못했습니다.`);
  }
  return await response.json();
}

async function loadAppData() {
  const [hotels, destinations, routes] = await Promise.all([
    loadJson("./data/hotels.json").catch(() => []),
    loadJson("./data/destinations.json"),
    loadJson("./data/routes.json"),
  ]);
  return { hotels, destinations, routes };
}

function loadGoogleMapsScript() {
  return new Promise((resolve, reject) => {
    if (window.google?.maps) {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=places&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function setSearchLoading(loading) {
  isSearching = loading;
  const searchBtn = document.getElementById("searchBtn");
  const resultList = document.getElementById("resultList");

  if (searchBtn) {
    searchBtn.disabled = loading;
    searchBtn.textContent = loading ? "검색중..." : "경로 찾기";
  }

  if (loading && resultList) {
    resultList.innerHTML = `
      <div class="route-card active">
        <div class="badge">검색중</div>
        <div class="route-card__hero">
          <div class="route-card__hero-label">계산중</div>
          <div class="route-card__hero-time">...</div>
          <div class="route-card__hero-sub">경로를 계산하고 있습니다</div>
        </div>
        <h3>잠시만 기다려주세요</h3>
        <p>도보, 셔틀, 하차 후 이동 구간을 계산 중입니다.</p>
      </div>
    `;
  }
}

function setMode(mode) {
  currentMode = mode;

  const tabs = {
    shuttle: document.getElementById("tabShuttle"),
    walk: document.getElementById("tabWalk"),
    bus: document.getElementById("tabBus"),
  };

  Object.values(tabs).forEach((btn) => btn?.classList.remove("active"));
  tabs[mode]?.classList.add("active");

  const modeNotice = document.getElementById("modeNotice");
  const sheetTitle = document.getElementById("sheetTitle");
  const sheetSubtitle = document.getElementById("sheetSubtitle");

  if (mode === "shuttle") {
    modeNotice.textContent = "기본 모드는 셔틀입니다.";
    sheetTitle.textContent = "추천 경로";
    sheetSubtitle.textContent = "셔틀 중심 경로를 비교할 수 있습니다.";
  } else if (mode === "walk") {
    modeNotice.textContent = "도보 직행 경로를 보여줍니다.";
    sheetTitle.textContent = "도보 경로";
    sheetSubtitle.textContent = "출발지에서 목적지까지 직접 걷는 경로입니다.";
  } else {
    modeNotice.textContent = "버스 기능은 준비중입니다.";
    sheetTitle.textContent = "버스";
    sheetSubtitle.textContent = "향후 마카오 일반 버스 기능을 지원할 예정입니다.";
  }
}

function setMapPickMode(mode) {
  mapPickMode = mode;

  const currentBtn = document.getElementById("pickCurrentBtn");
  const destinationBtn = document.getElementById("pickDestinationBtn");
  const statusEl = document.getElementById("mapPickStatus");
  const hintEl = document.getElementById("mapClickHint");

  currentBtn?.classList.remove("active");
  destinationBtn?.classList.remove("active");
  statusEl?.classList.remove("active");
  hintEl?.classList.add("hidden");

  if (mode === "current") {
    currentBtn?.classList.add("active");
    statusEl?.classList.add("active");
    statusEl.textContent = "지도에서 출발지를 선택하세요.";
    hintEl.textContent = "출발지 선택 모드";
    hintEl.classList.remove("hidden");
  } else if (mode === "destination") {
    destinationBtn?.classList.add("active");
    statusEl?.classList.add("active");
    statusEl.textContent = "지도에서 목적지를 선택하세요.";
    hintEl.textContent = "목적지 선택 모드";
    hintEl.classList.remove("hidden");
  } else {
    statusEl.textContent = "지도 클릭 기능 대기중";
  }
}

function setSheetState(nextState) {
  sheetState = nextState;
  const sheet = document.getElementById("bottomSheet");
  const collapseBtn = document.getElementById("collapseSheetBtn");
  sheet.classList.remove("sheet-collapsed", "sheet-mid", "sheet-expanded");

  if (nextState === "collapsed") sheet.classList.add("sheet-collapsed");
  else if (nextState === "expanded") sheet.classList.add("sheet-expanded");
  else sheet.classList.add("sheet-mid");

  if (collapseBtn) {
    collapseBtn.textContent = nextState === "collapsed" ? "펼치기" : "접기";
  }
}

function toggleSheetCollapse() {
  if (sheetState === "collapsed") setSheetState("mid");
  else setSheetState("collapsed");
}

function setSearchPanelCollapsed(collapsed) {
  const searchPanel = document.getElementById("searchPanel");
  const appShell = document.getElementById("appShell");

  searchPanel?.classList.toggle("collapsed", collapsed);
  appShell?.classList.toggle("search-collapsed", collapsed);
}

function collapseSearchPanel() {
  dismissAutocompleteUi();
  setSearchPanelCollapsed(true);
}

function expandSearchPanel() {
  setSearchPanelCollapsed(false);
}

function toggleSearchPanelCollapse() {
  const isCollapsed = document.getElementById("searchPanel")?.classList.contains("collapsed");
  setSearchPanelCollapsed(!isCollapsed);
}

function bindVerticalGesture(elements, { onSwipeUp, onSwipeDown, onTap, threshold = 24 }) {
  const targets = Array.isArray(elements) ? elements : [elements];
  let startY = 0;
  let tracking = false;

  const begin = (clientY) => {
    startY = clientY;
    tracking = true;
  };

  const end = (clientY) => {
    if (!tracking) return;

    tracking = false;
    const diff = clientY - startY;

    if (Math.abs(diff) < threshold) {
      onTap?.();
      return;
    }

    if (diff < 0) onSwipeUp?.();
    else onSwipeDown?.();
  };

  targets.forEach((target) => {
    target?.addEventListener("touchstart", (event) => {
      begin(event.touches[0].clientY);
    }, { passive: true });

    target?.addEventListener("mousedown", (event) => {
      begin(event.clientY);
    });
  });

  window.addEventListener("touchend", (event) => {
    if (!tracking) return;
    end(event.changedTouches[0].clientY);
  }, { passive: true });

  window.addEventListener("mouseup", (event) => {
    if (!tracking) return;
    end(event.clientY);
  });
}

function setupSearchPanel() {
  const searchDragHandle = document.getElementById("searchDragHandle");
  const searchPeekBtn = document.getElementById("searchPeekBtn");
  bindVerticalGesture([searchDragHandle, searchPeekBtn], {
    onSwipeUp: expandSearchPanel,
    onSwipeDown: collapseSearchPanel,
    onTap: () => {
      const isCollapsed = document.getElementById("searchPanel")?.classList.contains("collapsed");
      if (isCollapsed) expandSearchPanel();
      else collapseSearchPanel();
    },
  });
}

function updateMapSummary(route, rank = 1) {
  const card = document.getElementById("mapRouteSummary");
  const timeEl = document.getElementById("mapSummaryTime");
  const titleEl = document.getElementById("mapSummaryTitle");
  const metaEl = document.getElementById("mapSummaryMeta");

  if (!card || !timeEl || !titleEl || !metaEl) {
    return;
  }

  if (!route) {
    card.classList.add("hidden");
    return;
  }

  card.classList.remove("hidden");
  card.querySelector(".map-route-summary__badge").textContent = `추천 ${rank}`;

  if (route.recommendation_mode === "direct_walk") {
    timeEl.textContent = `${route.directWalkMinutes}분`;
    titleEl.textContent = "도보 직행";
    metaEl.textContent = `${formatKmFromMeters(route.directWalkDistanceMeters)} · 셔틀 없이 바로 이동`;
    return;
  }

  timeEl.textContent = `${route.totalMinutes}분`;
  titleEl.textContent = route.title_display;
  metaEl.textContent = `도보 ${route.walk1Minutes}분 · 셔틀 ${route.shuttleMinutes}분${route.walk2Minutes > 0 ? ` · 도보 ${route.walk2Minutes}분` : ""}`;
}

function isInsideMacau(lat, lng) {
  return (
    lat <= MACAU_BOUNDS.north &&
    lat >= MACAU_BOUNDS.south &&
    lng <= MACAU_BOUNDS.east &&
    lng >= MACAU_BOUNDS.west
  );
}

function hideAutocompleteDropdown() {
  setTimeout(() => {
    const pacContainers = document.querySelectorAll(".pac-container");
    pacContainers.forEach((el) => {
      el.style.display = "none";
      setTimeout(() => {
        el.style.display = "";
      }, 50);
    });
  }, 0);
}

function extractPlaceData(place) {
  if (!place) return null;
  const geometryLocation = place.geometry?.location;
  if (!geometryLocation) return null;

  const lat =
    typeof geometryLocation.lat === "function"
      ? geometryLocation.lat()
      : geometryLocation.lat;

  const lng =
    typeof geometryLocation.lng === "function"
      ? geometryLocation.lng()
      : geometryLocation.lng;

  if (!isInsideMacau(lat, lng)) return null;

  return {
    displayName: place.name || place.formatted_address || "",
    formattedAddress: place.formatted_address || place.name || "",
    location: { lat, lng },
  };
}

async function reverseGeocodeLatLng(latLng) {
  return new Promise((resolve, reject) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({ location: latLng }, (results, status) => {
      if (status === "OK" && results?.length) {
        const first = results[0];
        resolve({
          displayName: first.formatted_address || "선택한 위치",
          formattedAddress: first.formatted_address || "선택한 위치",
          location: {
            lat: typeof latLng.lat === "function" ? latLng.lat() : latLng.lat,
            lng: typeof latLng.lng === "function" ? latLng.lng() : latLng.lng,
          },
        });
      } else {
        reject(new Error(`역지오코딩 실패: ${status}`));
      }
    });
  });
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\w가-힣]+/g, "");
}

function buildHotelCatalog(routes) {
  const mapByName = new Map();

  routes.forEach((route) => {
    const name = route.hotel_display_name;
    const query = route.hotel_query || route.hotel_display_name;

    if (!mapByName.has(name)) {
      mapByName.set(name, {
        hotel_display_name: name,
        hotel_query: query,
        aliases: new Set(),
      });
    }

    const item = mapByName.get(name);
    item.aliases.add(normalizeText(name));
    item.aliases.add(normalizeText(query));
    (HOTEL_ALIASES[name] || []).forEach((alias) => item.aliases.add(normalizeText(alias)));
  });

  return Array.from(mapByName.values()).map((item) => ({
    ...item,
    aliases: Array.from(item.aliases),
  }));
}

function detectHotelByText(hotelCatalog, rawText) {
  const normalized = normalizeText(rawText);
  if (!normalized) return null;

  for (const hotel of hotelCatalog) {
    for (const alias of hotel.aliases) {
      if (!alias) continue;
      if (normalized.includes(alias) || alias.includes(normalized)) {
        return hotel;
      }
    }
  }

  return null;
}

function normalizeRoutePoint(point) {
  if (!point) return null;
  if (typeof point === "string") return point;

  if (typeof point.lat === "number" && typeof point.lng === "number") {
    return { lat: Number(point.lat), lng: Number(point.lng) };
  }

  if (typeof point.lat === "function" && typeof point.lng === "function") {
    return { lat: Number(point.lat()), lng: Number(point.lng()) };
  }

  if (
    point.location &&
    typeof point.location.lat === "number" &&
    typeof point.location.lng === "number"
  ) {
    return { lat: Number(point.location.lat), lng: Number(point.location.lng) };
  }

  if (
    point.location &&
    typeof point.location.lat === "function" &&
    typeof point.location.lng === "function"
  ) {
    return { lat: Number(point.location.lat()), lng: Number(point.location.lng()) };
  }

  return point;
}

function getPlaceLocationString(placeObj) {
  if (!placeObj) return null;
  return placeObj.formattedAddress || placeObj.displayName || null;
}

function clearMapOverlays() {
  routeOverlays.forEach((item) => item.setMap(null));
  routeOverlays = [];
  mapMarkers.forEach((item) => item.setMap(null));
  mapMarkers = [];
}

function addMarker(position, title, labelText, color, infoContent = "") {
  const normalized = normalizeRoutePoint(position);

  const marker = new google.maps.Marker({
    position: normalized,
    map,
    title,
    label: {
      text: labelText,
      color: "#111",
      fontSize: "12px",
      fontWeight: "700",
    },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 8,
      fillColor: color,
      fillOpacity: 1,
      strokeColor: "#ffffff",
      strokeWeight: 2,
    },
  });

  if (infoContent) {
    const infoWindow = new google.maps.InfoWindow({
      content: `<div style="font-size:13px;line-height:1.45;"><strong>${labelText}</strong><br>${infoContent}</div>`,
    });

    marker.addListener("click", () => {
      infoWindow.open({ anchor: marker, map });
    });
  }

  mapMarkers.push(marker);
  return marker;
}

function getDestinationMeta(route, destinations) {
  const found = destinations.find(
    (item) =>
      item.destination_standard === route.destination_standard ||
      item.destination_raw === route.destination_raw
  );

  return {
    query: found?.google_maps_query || route.destination_standard || route.destination_raw,
    label: found?.destination_standard || route.destination_standard || route.destination_raw,
  };
}

function getHotelBoardingPoint(route) {
  return route.hotel_query || route.hotel_display_name;
}

function formatKmFromMeters(meters) {
  if (typeof meters !== "number" || !Number.isFinite(meters)) return "-";
  return `${(meters / 1000).toFixed(1)} km`;
}

function buildShuttleBusName(route) {
  return `${route.hotel_display_name} Shuttle Bus`;
}

function normalizePlaceName(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3131-\u318e\uac00-\ud7a3]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function placeNameMatches(a, b) {
  const normalizedA = normalizePlaceName(a);
  const normalizedB = normalizePlaceName(b);

  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return true;
  return (
    normalizedA.length >= 5 &&
    normalizedB.length >= 5 &&
    (normalizedA.includes(normalizedB) || normalizedB.includes(normalizedA))
  );
}

function routePlaceMatches(placeText, targetText, hotelCatalog) {
  if (placeNameMatches(placeText, targetText)) return true;

  const placeHotel = detectHotelByText(hotelCatalog, placeText);
  const targetHotel = detectHotelByText(hotelCatalog, targetText);

  if (placeHotel && targetHotel) {
    return placeHotel.hotel_display_name === targetHotel.hotel_display_name;
  }

  return false;
}

function detectHotelFromPlace(hotelCatalog, placeObj, fallbackInput = "") {
  return (
    detectHotelByText(hotelCatalog, fallbackInput) ||
    detectHotelByText(hotelCatalog, placeObj?.displayName) ||
    detectHotelByText(hotelCatalog, placeObj?.formattedAddress)
  );
}

function dismissAutocompleteUi() {
  document.getElementById("currentInput")?.blur();
  document.getElementById("destinationInput")?.blur();

  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
}

async function buildTransferToBoardingOption({
  routes,
  destinations,
  hotelCatalog,
  originHotel,
  transferStopLabel,
}) {
  if (!originHotel || !transferStopLabel) return null;

  const transferCandidates = [];

  for (const route of routes) {
    const destinationMeta = getDestinationMeta(route, destinations);

    if (
      route.hotel_display_name === originHotel.hotel_display_name &&
      routePlaceMatches(destinationMeta.label, transferStopLabel, hotelCatalog)
    ) {
      try {
        const shuttleDrive = await computeDrivingRouteStrict(
          route.hotel_query || route.hotel_display_name,
          destinationMeta.query
        );

        transferCandidates.push({
          mode: "origin_outbound",
          shuttleBusName: buildShuttleBusName(route),
          boardingLabel: originHotel.hotel_display_name,
          dropOffLabel: destinationMeta.label,
          shuttleMinutes: shuttleDrive.minutes,
          shuttleDistanceMeters: shuttleDrive.distanceMeters,
          direction_display: route.direction_outbound_time || route.direction_inbound_time,
          headway_display: route.headway,
          boardingForDraw: route.hotel_query || route.hotel_display_name,
          dropoffForDraw: destinationMeta.query,
          note: `${originHotel.hotel_display_name} 셔틀로 ${destinationMeta.label}까지 이동`,
        });
      } catch (error) {}
    }

    if (
      routePlaceMatches(route.hotel_display_name, transferStopLabel, hotelCatalog) &&
      routePlaceMatches(destinationMeta.label, originHotel.hotel_display_name, hotelCatalog)
    ) {
      try {
        const shuttleDrive = await computeDrivingRouteStrict(
          destinationMeta.query,
          route.hotel_query || route.hotel_display_name
        );

        transferCandidates.push({
          mode: "transfer_inbound",
          shuttleBusName: buildShuttleBusName(route),
          boardingLabel: destinationMeta.label,
          dropOffLabel: route.hotel_display_name,
          shuttleMinutes: shuttleDrive.minutes,
          shuttleDistanceMeters: shuttleDrive.distanceMeters,
          direction_display: route.direction_inbound_time || route.direction_outbound_time,
          headway_display: route.headway,
          boardingForDraw: destinationMeta.query,
          dropoffForDraw: route.hotel_query || route.hotel_display_name,
          note: `${destinationMeta.label}에서 ${route.hotel_display_name} 셔틀로 환승지까지 이동`,
        });
      } catch (error) {}
    }
  }

  transferCandidates.sort((a, b) => a.shuttleMinutes - b.shuttleMinutes);
  return transferCandidates[0] || null;
}

async function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const geocoder = new google.maps.Geocoder();
    geocoder.geocode(
      {
        address,
        bounds: MACAU_BOUNDS,
        region: "MO",
      },
      (results, status) => {
        if (status === "OK" && results?.length) {
          const loc = results[0].geometry.location;
          const lat = typeof loc.lat === "function" ? loc.lat() : loc.lat;
          const lng = typeof loc.lng === "function" ? loc.lng() : loc.lng;

          if (!isInsideMacau(lat, lng)) {
            reject(new Error(`마카오 외 지역으로 인식됨: ${address}`));
            return;
          }

          resolve(loc);
        } else {
          reject(new Error(`지오코딩 실패: ${address} / ${status}`));
        }
      }
    );
  });
}

async function toLatLng(point) {
  const normalized = normalizeRoutePoint(point);
  if (typeof normalized === "string") {
    const geo = await geocodeAddress(normalized);
    return {
      lat: typeof geo.lat === "function" ? geo.lat() : geo.lat,
      lng: typeof geo.lng === "function" ? geo.lng() : geo.lng,
    };
  }
  return normalized;
}

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;

  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;

  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);

  const y = 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
  return R * y;
}

function estimateWalkingMinutes(a, b) {
  const km = haversineKm(a, b);
  return Math.max(1, Math.round((km / SETTINGS.WALKING_FALLBACK_KMH) * 60));
}

function getPolylineOptionsByType(segmentType) {
  if (segmentType === "walkStart") {
    return {
      strokeColor: "#2563eb",
      strokeOpacity: 0,
      strokeWeight: 5,
      icons: [{
        icon: {
          path: "M 0,-1 0,1",
          strokeOpacity: 1,
          strokeColor: "#2563eb",
          scale: 4,
        },
        offset: "0",
        repeat: "14px",
      }],
    };
  }

  if (segmentType === "walkEnd") {
    return {
      strokeColor: "#ea580c",
      strokeOpacity: 0,
      strokeWeight: 5,
      icons: [{
        icon: {
          path: "M 0,-1 0,1",
          strokeOpacity: 1,
          strokeColor: "#ea580c",
          scale: 4,
        },
        offset: "0",
        repeat: "14px",
      }],
    };
  }

  return {
    strokeColor: "#16a34a",
    strokeOpacity: 0.95,
    strokeWeight: 6,
  };
}

function drawFallbackDashedLine(from, to, segmentType) {
  const options = getPolylineOptionsByType(segmentType);
  const polyline = new google.maps.Polyline({
    path: [from, to],
    geodesic: true,
    ...options,
    map,
  });
  routeOverlays.push(polyline);
}

async function computePreciseRouteNoDraw(origin, destination, travelMode) {
  const { Route } = await google.maps.importLibrary("routes");

  const request = {
    origin: normalizeRoutePoint(origin),
    destination: normalizeRoutePoint(destination),
    travelMode,
    fields: ["durationMillis", "distanceMeters"],
  };

  const { routes } = await Route.computeRoutes(request);

  if (!routes || !routes.length) {
    throw new Error(`정밀 경로 없음: ${travelMode}`);
  }

  const route = routes[0];

  return {
    minutes:
      typeof route.durationMillis === "number"
        ? Math.round(route.durationMillis / 1000 / 60)
        : 999,
    distanceMeters:
      typeof route.distanceMeters === "number"
        ? route.distanceMeters
        : null,
    isFallback: false,
  };
}

async function computeWalkingRouteFlexible(origin, destination) {
  try {
    return await computePreciseRouteNoDraw(origin, destination, google.maps.TravelMode.WALKING);
  } catch (error) {
    const from = await toLatLng(origin);
    const to = await toLatLng(destination);
    const distanceMeters = Math.round(haversineKm(from, to) * 1000);

    return {
      minutes: estimateWalkingMinutes(from, to),
      distanceMeters,
      isFallback: true,
      fallbackFrom: from,
      fallbackTo: to,
    };
  }
}

async function computeDrivingRouteStrict(origin, destination) {
  return await computePreciseRouteNoDraw(origin, destination, google.maps.TravelMode.DRIVING);
}

async function drawSegment(origin, destination, travelMode, segmentType) {
  const { Route } = await google.maps.importLibrary("routes");

  const request = {
    origin: normalizeRoutePoint(origin),
    destination: normalizeRoutePoint(destination),
    travelMode,
    fields: ["path"],
  };

  const { routes } = await Route.computeRoutes(request);

  if (!routes || !routes.length) {
    throw new Error(`지도용 경로 없음: ${travelMode}`);
  }

  const route = routes[0];
  const styleOptions = getPolylineOptionsByType(segmentType);

  const polylines = route.createPolylines({
    polylineOptions: (defaults) => ({
      ...defaults,
      ...styleOptions,
    }),
  });

  polylines.forEach((polyline) => {
    polyline.setMap(map);
    routeOverlays.push(polyline);
  });
}

async function detectNearestHotelByLocation(hotelCatalog, destinationLocation) {
  if (!destinationLocation) return null;

  let bestHotel = null;
  let bestDistance = Infinity;

  for (const hotel of hotelCatalog) {
    try {
      const geo = await geocodeAddress(hotel.hotel_query);
      const hotelLatLng = {
        lat: typeof geo.lat === "function" ? geo.lat() : geo.lat,
        lng: typeof geo.lng === "function" ? geo.lng() : geo.lng,
      };

      const distanceMeters = Math.round(haversineKm(destinationLocation, hotelLatLng) * 1000);

      if (distanceMeters < bestDistance) {
        bestDistance = distanceMeters;
        bestHotel = hotel;
      }
    } catch (error) {}
  }

  if (bestHotel && bestDistance <= SETTINGS.HOTEL_DEST_RADIUS_M) {
    return { hotel: bestHotel, distanceMeters: bestDistance };
  }

  return null;
}

function buildDirectWalkCard(directWalk) {
  return {
    recommendation_mode: "direct_walk",
    title_display: "도보 직행",
    directWalkMinutes: directWalk.minutes,
    directWalkDistanceMeters: directWalk.distanceMeters,
    totalMinutes: directWalk.minutes,
    calcNote: "도보 직행",
    note: "셔틀을 이용하지 않고 바로 이동하는 경로",
    originForDraw: currentPlace.location,
    destinationForDraw: destinationPlace.location,
    walkStartFallback: directWalk.isFallback
      ? { from: directWalk.fallbackFrom, to: directWalk.fallbackTo }
      : null,
    walk2Minutes: 0,
    nearHotelNotice: latestSearchContext.nearHotelNotice || "",
  };
}

async function buildHotelModeCandidates({
  routes,
  destinations,
  hotelCatalog,
  currentOrigin,
  originHotel,
  targetHotel,
  actualDestination,
}) {
  const candidates = [];
  const errors = [];

  const targetHotelWalk = await computeWalkingRouteFlexible(currentOrigin, targetHotel.hotel_query);
  const hotelToActualDestination = await computeWalkingRouteFlexible(targetHotel.hotel_query, actualDestination);
  const finalWalkFromHotelNeeded =
    hotelToActualDestination.distanceMeters > SETTINGS.HOTEL_FINAL_WALK_IGNORE_M;

  const inboundRoutes = routes.filter(
    (route) => route.hotel_display_name === targetHotel.hotel_display_name
  );

  for (const route of inboundRoutes) {
    try {
      const destinationMeta = getDestinationMeta(route, destinations);
      const externalStop = destinationMeta.query;

      const walkToBoarding = await computeWalkingRouteFlexible(currentOrigin, externalStop);
      const shuttleDrive = await computeDrivingRouteStrict(externalStop, targetHotel.hotel_query);
      const transferToBoarding = await buildTransferToBoardingOption({
        routes,
        destinations,
        hotelCatalog,
        originHotel,
        transferStopLabel: destinationMeta.label,
      });
      const useTransferToBoarding =
        transferToBoarding &&
        transferToBoarding.shuttleMinutes < walkToBoarding.minutes;

      if (
        !useTransferToBoarding &&
        walkToBoarding.distanceMeters >= targetHotelWalk.distanceMeters - 50
      ) continue;

      const walk2Minutes = finalWalkFromHotelNeeded ? hotelToActualDestination.minutes : 0;
      const walk2DistanceMeters = finalWalkFromHotelNeeded ? hotelToActualDestination.distanceMeters : 0;
      const accessMinutes = useTransferToBoarding ? transferToBoarding.shuttleMinutes : walkToBoarding.minutes;
      const accessDistanceMeters = useTransferToBoarding
        ? transferToBoarding.shuttleDistanceMeters
        : walkToBoarding.distanceMeters;

      candidates.push({
        ...route,
        recommendation_mode: "hotel_inbound",
        title_display: useTransferToBoarding
          ? `${route.hotel_display_name} Shuttle Bus 환승`
          : `${route.hotel_display_name} Shuttle Bus`,
        shuttleBusName: buildShuttleBusName(route),
        boardingLabel: destinationMeta.label,
        dropOffLabel: targetHotel.hotel_display_name,
        walk1LabelTo: destinationMeta.label,
        walk1Minutes: useTransferToBoarding ? 0 : walkToBoarding.minutes,
        walk1DistanceMeters: useTransferToBoarding ? 0 : walkToBoarding.distanceMeters,
        shuttleFromLabel: destinationMeta.label,
        shuttleToLabel: targetHotel.hotel_display_name,
        shuttleMinutes: shuttleDrive.minutes,
        shuttleDistanceMeters: shuttleDrive.distanceMeters,
        accessMode: useTransferToBoarding ? "shuttle_transfer" : "walk",
        accessLabel: useTransferToBoarding ? "1차 셔틀" : "도보 1",
        accessMinutes,
        accessDistanceMeters,
        accessShuttleBusName: useTransferToBoarding ? transferToBoarding.shuttleBusName : "",
        accessBoardingLabel: useTransferToBoarding ? transferToBoarding.boardingLabel : "",
        accessDropOffLabel: useTransferToBoarding ? transferToBoarding.dropOffLabel : "",
        accessDirectionDisplay: useTransferToBoarding ? transferToBoarding.direction_display : "",
        accessHeadwayDisplay: useTransferToBoarding ? transferToBoarding.headway_display : "",
        accessBoardingForDraw: useTransferToBoarding ? transferToBoarding.boardingForDraw : null,
        accessDropoffForDraw: useTransferToBoarding ? transferToBoarding.dropoffForDraw : null,
        walk2LabelFrom: targetHotel.hotel_display_name,
        walk2LabelTo: "목적지",
        walk2Minutes,
        walk2DistanceMeters,
        totalMinutes: accessMinutes + shuttleDrive.minutes + walk2Minutes,
        calcNote: useTransferToBoarding
          ? "호텔목적지모드(1회 환승 셔틀)"
          : "호텔목적지모드(목적지 호텔 운행 셔틀 탑승)",
        originForDraw: currentOrigin,
        boardingForDraw: externalStop,
        dropoffForDraw: targetHotel.hotel_query,
        destinationForDraw: actualDestination,
        walkStartFallback: !useTransferToBoarding && walkToBoarding.isFallback
          ? { from: walkToBoarding.fallbackFrom, to: walkToBoarding.fallbackTo }
          : null,
        walkEndFallback:
          finalWalkFromHotelNeeded && hotelToActualDestination.isFallback
            ? { from: hotelToActualDestination.fallbackFrom, to: hotelToActualDestination.fallbackTo }
            : null,
        direction_display: route.direction_inbound_time || route.direction_outbound_time,
        headway_display: route.headway,
        note: useTransferToBoarding
          ? `${transferToBoarding.note} 후 ${targetHotel.hotel_display_name} 셔틀로 환승`
          : `목적지 호텔(${targetHotel.hotel_display_name}) 운행 셔틀 활용`,
        nearHotelNotice: latestSearchContext.nearHotelNotice || "",
      });
    } catch (error) {
      errors.push({
        type: "hotel_inbound",
        route_id: route.route_id,
        hotel: route.hotel_display_name,
        reason: error.message,
      });
    }
  }

  for (const route of routes) {
    try {
      if (route.hotel_display_name === targetHotel.hotel_display_name) continue;

      const boardingPoint = getHotelBoardingPoint(route);
      const destinationMeta = getDestinationMeta(route, destinations);

      const walkToBoarding = await computeWalkingRouteFlexible(currentOrigin, boardingPoint);
      const shuttleDrive = await computeDrivingRouteStrict(boardingPoint, destinationMeta.query);
      const walkAfterDrop = await computeWalkingRouteFlexible(destinationMeta.query, actualDestination);

      if (walkAfterDrop.distanceMeters > SETTINGS.MAX_LAST_WALK_M) continue;
      if (walkAfterDrop.distanceMeters > walkToBoarding.distanceMeters + SETTINGS.DROP_CLOSER_MARGIN_M) continue;

      if (
        targetHotelWalk.distanceMeters <= SETTINGS.DIRECT_WALK_PRIORITY_M &&
        walkToBoarding.minutes + shuttleDrive.minutes + walkAfterDrop.minutes >= targetHotelWalk.minutes
      ) {
        continue;
      }

      candidates.push({
        ...route,
        recommendation_mode: "hotel_nearby_dropoff",
        title_display: `${route.hotel_display_name} Shuttle Bus`,
        shuttleBusName: buildShuttleBusName(route),
        boardingLabel: route.hotel_display_name,
        dropOffLabel: destinationMeta.label,
        walk1LabelTo: route.hotel_display_name,
        walk1Minutes: walkToBoarding.minutes,
        walk1DistanceMeters: walkToBoarding.distanceMeters,
        shuttleFromLabel: route.hotel_display_name,
        shuttleToLabel: destinationMeta.label,
        shuttleMinutes: shuttleDrive.minutes,
        shuttleDistanceMeters: shuttleDrive.distanceMeters,
        walk2LabelFrom: destinationMeta.label,
        walk2LabelTo: "목적지",
        walk2Minutes: walkAfterDrop.minutes,
        walk2DistanceMeters: walkAfterDrop.distanceMeters,
        totalMinutes: walkToBoarding.minutes + shuttleDrive.minutes + walkAfterDrop.minutes,
        calcNote: "호텔목적지모드(근처 하차 후 도보)",
        originForDraw: currentOrigin,
        boardingForDraw: boardingPoint,
        dropoffForDraw: destinationMeta.query,
        destinationForDraw: actualDestination,
        walkStartFallback: walkToBoarding.isFallback
          ? { from: walkToBoarding.fallbackFrom, to: walkToBoarding.fallbackTo }
          : null,
        walkEndFallback: walkAfterDrop.isFallback
          ? { from: walkAfterDrop.fallbackFrom, to: walkAfterDrop.fallbackTo }
          : null,
        direction_display: route.direction_outbound_time,
        headway_display: route.headway,
        note: route.note || "",
        nearHotelNotice: latestSearchContext.nearHotelNotice || "",
      });
    } catch (error) {
      errors.push({
        type: "hotel_nearby_dropoff",
        route_id: route.route_id,
        hotel: route.hotel_display_name,
        reason: error.message,
      });
    }
  }

  return { candidates, errors };
}

async function buildGeneralCandidates({ routes, destinations, currentOrigin, finalDestination }) {
  const candidates = [];
  const errors = [];
  const directWalkToDestination = await computeWalkingRouteFlexible(currentOrigin, finalDestination);

  for (const route of routes) {
    try {
      const boardingPoint = getHotelBoardingPoint(route);
      const destinationMeta = getDestinationMeta(route, destinations);

      const walkToBoarding = await computeWalkingRouteFlexible(currentOrigin, boardingPoint);
      const shuttleDrive = await computeDrivingRouteStrict(boardingPoint, destinationMeta.query);
      const walkAfterDrop = await computeWalkingRouteFlexible(destinationMeta.query, finalDestination);

      if (walkAfterDrop.distanceMeters > SETTINGS.MAX_LAST_WALK_M) continue;
      if (walkAfterDrop.distanceMeters > walkToBoarding.distanceMeters + SETTINGS.DROP_CLOSER_MARGIN_M) continue;

      if (
        directWalkToDestination.distanceMeters <= SETTINGS.DIRECT_WALK_PRIORITY_M &&
        walkToBoarding.minutes + shuttleDrive.minutes + walkAfterDrop.minutes >= directWalkToDestination.minutes
      ) {
        continue;
      }

      candidates.push({
        ...route,
        recommendation_mode: "general",
        title_display: `${route.hotel_display_name} Shuttle Bus`,
        shuttleBusName: buildShuttleBusName(route),
        boardingLabel: route.hotel_display_name,
        dropOffLabel: destinationMeta.label,
        walk1LabelTo: route.hotel_display_name,
        walk1Minutes: walkToBoarding.minutes,
        walk1DistanceMeters: walkToBoarding.distanceMeters,
        shuttleFromLabel: route.hotel_display_name,
        shuttleToLabel: destinationMeta.label,
        shuttleMinutes: shuttleDrive.minutes,
        shuttleDistanceMeters: shuttleDrive.distanceMeters,
        walk2LabelFrom: destinationMeta.label,
        walk2LabelTo: "목적지",
        walk2Minutes: walkAfterDrop.minutes,
        walk2DistanceMeters: walkAfterDrop.distanceMeters,
        totalMinutes: walkToBoarding.minutes + shuttleDrive.minutes + walkAfterDrop.minutes,
        calcNote: "정밀형(Routes API, 도보 fallback 포함)",
        originForDraw: currentOrigin,
        boardingForDraw: boardingPoint,
        dropoffForDraw: destinationMeta.query,
        destinationForDraw: finalDestination,
        walkStartFallback: walkToBoarding.isFallback
          ? { from: walkToBoarding.fallbackFrom, to: walkToBoarding.fallbackTo }
          : null,
        walkEndFallback: walkAfterDrop.isFallback
          ? { from: walkAfterDrop.fallbackFrom, to: walkAfterDrop.fallbackTo }
          : null,
        direction_display: route.direction_outbound_time,
        headway_display: route.headway,
        note: route.note || "",
        nearHotelNotice: latestSearchContext.nearHotelNotice || "",
      });
    } catch (error) {
      errors.push({
        type: "general",
        route_id: route.route_id,
        hotel: route.hotel_display_name,
        destination: route.destination_standard,
        reason: error.message,
      });
    }
  }

  return { candidates, errors };
}

async function recommendShuttleRoutes(routes, destinations, currentPlaceObj, destinationPlaceObj) {
  const activeRoutes = routes.filter((route) => route.status === "active");
  const currentOrigin = currentPlaceObj?.location || getPlaceLocationString(currentPlaceObj);
  const finalDestination = destinationPlaceObj?.location || getPlaceLocationString(destinationPlaceObj);

  if (!currentOrigin) throw new Error("현재 위치/출발지 정보가 없습니다.");
  if (!finalDestination) throw new Error("목적지 정보가 없습니다.");

  const hotelCatalog = buildHotelCatalog(activeRoutes);
  const currentInputValue = document.getElementById("currentInput")?.value || "";
  const destinationInputValue = document.getElementById("destinationInput")?.value || "";
  const originHotel = detectHotelFromPlace(hotelCatalog, currentPlaceObj, currentInputValue);

  latestSearchContext = {
    nearHotelNotice: "",
    targetHotelName: "",
    targetHotelByNearby: false,
    directWalk: null,
  };

  let targetHotel =
    detectHotelByText(hotelCatalog, destinationInputValue) ||
    detectHotelByText(hotelCatalog, destinationPlaceObj?.displayName) ||
    detectHotelByText(hotelCatalog, destinationPlaceObj?.formattedAddress);

  if (!targetHotel && destinationPlaceObj?.location) {
    const nearestHotelInfo = await detectNearestHotelByLocation(hotelCatalog, destinationPlaceObj.location);
    if (nearestHotelInfo) {
      targetHotel = nearestHotelInfo.hotel;
      latestSearchContext.nearHotelNotice = `선택한 목적지는 ${nearestHotelInfo.hotel.hotel_display_name} 근처입니다.`;
      latestSearchContext.targetHotelName = nearestHotelInfo.hotel.hotel_display_name;
      latestSearchContext.targetHotelByNearby = true;
    }
  }

  const directWalk = await computeWalkingRouteFlexible(currentOrigin, finalDestination);
  latestSearchContext.directWalk = directWalk;

  let candidates = [];
  let errors = [];

  if (targetHotel) {
    const hotelMode = await buildHotelModeCandidates({
      routes: activeRoutes,
      destinations,
      hotelCatalog,
      currentOrigin,
      originHotel,
      targetHotel,
      actualDestination: finalDestination,
    });
    candidates = hotelMode.candidates;
    errors = hotelMode.errors;
  } else {
    const generalMode = await buildGeneralCandidates({
      routes: activeRoutes,
      destinations,
      currentOrigin,
      finalDestination,
    });
    candidates = generalMode.candidates;
    errors = generalMode.errors;
  }

  console.log("route calculation errors raw:", JSON.stringify(errors, null, 2));

  candidates.sort((a, b) => a.totalMinutes - b.totalMinutes);
  const topCandidates = candidates.slice(0, SETTINGS.MAX_RESULTS);

  if (topCandidates.length === 0 || directWalk.minutes < topCandidates[0].totalMinutes) {
    const walkingCard = buildDirectWalkCard(directWalk);
    return [walkingCard, ...topCandidates].slice(0, SETTINGS.MAX_RESULTS);
  }

  return topCandidates;
}

async function recommendWalkOnly(currentPlaceObj, destinationPlaceObj) {
  const currentOrigin = currentPlaceObj?.location || getPlaceLocationString(currentPlaceObj);
  const finalDestination = destinationPlaceObj?.location || getPlaceLocationString(destinationPlaceObj);

  if (!currentOrigin) throw new Error("현재 위치/출발지 정보가 없습니다.");
  if (!finalDestination) throw new Error("목적지 정보가 없습니다.");

  const directWalk = await computeWalkingRouteFlexible(currentOrigin, finalDestination);
  latestSearchContext.directWalk = directWalk;
  return [buildDirectWalkCard(directWalk)];
}

function buildRouteHero(route) {
  if (route.recommendation_mode === "direct_walk") {
    return `
      <div class="route-card__hero">
        <div class="route-card__hero-label">총 예상시간</div>
        <div class="route-card__hero-time">${route.directWalkMinutes}분</div>
        <div class="route-card__hero-sub">${formatKmFromMeters(route.directWalkDistanceMeters)} · 도보 직행</div>
      </div>
    `;
  }

  return `
    <div class="route-card__hero">
      <div class="route-card__hero-label">총 예상시간</div>
      <div class="route-card__hero-time">${route.totalMinutes}분</div>
      <div class="route-card__hero-sub">${buildRouteHeroSummary(route)}</div>
    </div>
  `;
}

function buildRouteHeroSummary(route) {
  if (route.accessMode === "shuttle_transfer") {
    return `셔틀 ${route.accessMinutes}분 · 셔틀 ${route.shuttleMinutes}분${route.walk2Minutes > 0 ? ` · 도보 ${route.walk2Minutes}분` : ""}`;
  }

  return `도보 ${route.walk1Minutes}분 · 셔틀 ${route.shuttleMinutes}분${route.walk2Minutes > 0 ? ` · 도보 ${route.walk2Minutes}분` : ""}`;
}

function renderResults(results) {
  latestResults = results;
  const resultList = document.getElementById("resultList");

  if (!results.length) {
    resultList.innerHTML = `
      <div class="empty-state">
        <strong>추천 가능한 경로가 없습니다.</strong>
        <p>출발지와 목적지를 다시 확인해주세요.</p>
      </div>
    `;
    updateMapSummary(null);
    return;
  }

  resultList.innerHTML = results
    .map((route, index) => {
      const nearHotelNoticeBlock = route.nearHotelNotice
        ? `<div style="margin-bottom:10px;padding:8px 10px;border-radius:10px;background:#eef4ff;color:#2747c7;font-size:13px;font-weight:700;">${route.nearHotelNotice}</div>`
        : "";

      if (route.recommendation_mode === "direct_walk") {
        return `
          <div class="route-card ${index === selectedRouteIndex ? "active" : ""}" data-route-index="${index}">
            <div class="badge">추천 ${index + 1}</div>
            ${nearHotelNoticeBlock}
            ${buildRouteHero(route)}
            <h3>도보 직행</h3>
            <p><strong>거리:</strong> ${formatKmFromMeters(route.directWalkDistanceMeters)}</p>
            <p><strong>비고:</strong> ${route.note || "-"}</p>
          </div>
        `;
      }

      const walk2Block = route.walk2Minutes > 0
        ? `<p><strong>도보 2:</strong> ${route.walk2Minutes}분 · ${formatKmFromMeters(route.walk2DistanceMeters)}</p>`
        : "";
      const accessBlock = route.accessMode === "shuttle_transfer"
        ? `
          <p><strong>1차 셔틀 탑승:</strong> ${route.accessBoardingLabel}</p>
          <p><strong>1차 셔틀:</strong> ${route.accessShuttleBusName} · ${route.accessMinutes}분</p>
          <p><strong>환승 위치:</strong> ${route.accessDropOffLabel}</p>
          <p><strong>2차 셔틀 탑승:</strong> ${route.boardingLabel}</p>
        `
        : `<p><strong>셔틀 탑승:</strong> ${route.boardingLabel}</p>`;

      return `
        <div class="route-card ${index === selectedRouteIndex ? "active" : ""}" data-route-index="${index}">
          <div class="badge">추천 ${index + 1}</div>
          ${nearHotelNoticeBlock}
          ${buildRouteHero(route)}
          <h3>${route.title_display}</h3>
          ${route.accessMode === "shuttle_transfer" ? "" : `<p><strong>도보 1:</strong> ${route.walk1Minutes}분 · ${formatKmFromMeters(route.walk1DistanceMeters)}</p>`}
          ${accessBlock}
          <p><strong>셔틀:</strong> ${route.shuttleMinutes}분 · ${formatKmFromMeters(route.shuttleDistanceMeters)}</p>
          <p><strong>노선:</strong> ${route.shuttleBusName}</p>
          <p><strong>운행:</strong> ${route.direction_display || "-"} / ${route.headway_display || "-"}</p>
          ${walk2Block}
          <p><strong>비고:</strong> ${route.note || "-"}</p>
        </div>
      `;
    })
    .join("");

  document.querySelectorAll(".route-card").forEach((card) => {
    card.addEventListener("click", async () => {
      selectedRouteIndex = Number(card.dataset.routeIndex);
      renderResults(latestResults);
      const selectedRoute = latestResults[selectedRouteIndex];
      if (selectedRoute) {
        updateMapSummary(selectedRoute, selectedRouteIndex + 1);
        await drawRecommendedRoute(selectedRoute);
      }
    });
  });

  updateMapSummary(results[0], 1);
}

function renderBusPlaceholder() {
  const resultList = document.getElementById("resultList");
  resultList.innerHTML = `
    <div class="route-card active">
      <div class="badge">준비중</div>
      <div class="route-card__hero">
        <div class="route-card__hero-label">상태</div>
        <div class="route-card__hero-time">준비중</div>
        <div class="route-card__hero-sub">향후 지원 예정</div>
      </div>
      <h3>버스 기능</h3>
      <p>현재 버스 모드는 아직 구현 전입니다.</p>
      <p>향후 마카오 일반 버스 노선 데이터 또는 대중교통 API 연동 후 지원 예정입니다.</p>
    </div>
  `;
  updateMapSummary(null);
}

async function drawRecommendedRoute(route) {
  clearMapOverlays();
  const bounds = new google.maps.LatLngBounds();

  if (route.recommendation_mode === "direct_walk") {
    if (route.walkStartFallback) {
      drawFallbackDashedLine(route.walkStartFallback.from, route.walkStartFallback.to, "walkStart");
    } else {
      await drawSegment(route.originForDraw, route.destinationForDraw, google.maps.TravelMode.WALKING, "walkStart");
    }

    addMarker(
      currentPlace.location,
      "출발지",
      "출발",
      "#2563eb",
      currentPlace.displayName || currentPlace.formattedAddress || ""
    );

    addMarker(
      destinationPlace.location,
      destinationPlace.displayName || destinationPlace.formattedAddress || "목적지",
      "목적지",
      "#dc2626",
      destinationPlace.displayName || destinationPlace.formattedAddress || ""
    );

    bounds.extend(normalizeRoutePoint(currentPlace.location));
    bounds.extend(normalizeRoutePoint(destinationPlace.location));
    map.fitBounds(bounds);
    return;
  }

  if (route.accessMode === "shuttle_transfer" && route.accessBoardingForDraw && route.accessDropoffForDraw) {
    await drawSegment(
      route.accessBoardingForDraw,
      route.accessDropoffForDraw,
      google.maps.TravelMode.DRIVING,
      "shuttle"
    );
  } else if (route.walkStartFallback) {
    drawFallbackDashedLine(route.walkStartFallback.from, route.walkStartFallback.to, "walkStart");
  } else {
    await drawSegment(route.originForDraw, route.boardingForDraw, google.maps.TravelMode.WALKING, "walkStart");
  }

  await drawSegment(route.boardingForDraw, route.dropoffForDraw, google.maps.TravelMode.DRIVING, "shuttle");

  if (route.walkEndFallback) {
    drawFallbackDashedLine(route.walkEndFallback.from, route.walkEndFallback.to, "walkEnd");
  } else if (route.walk2Minutes > 0) {
    await drawSegment(route.dropoffForDraw, route.destinationForDraw, google.maps.TravelMode.WALKING, "walkEnd");
  }

  const boardingLatLng = await geocodeAddress(route.boardingForDraw);

  addMarker(
    currentPlace.location,
    "출발지",
    "출발",
    "#2563eb",
    route.accessMode === "shuttle_transfer" && route.accessShuttleBusName
      ? `${currentPlace.displayName || currentPlace.formattedAddress || ""}<br>1차 탑승: ${route.accessBoardingLabel} (${route.accessShuttleBusName})`
      : currentPlace.displayName || currentPlace.formattedAddress || ""
  );

  if (route.accessMode === "shuttle_transfer") {
    addMarker(
      boardingLatLng,
      route.boardingLabel || "환승지",
      "환승",
      "#f59e0b",
      `2차 탑승 위치: ${route.boardingLabel || "환승지"}<br>노선: ${route.shuttleBusName}`
    );
  } else {
    addMarker(
      boardingLatLng,
      route.boardingLabel || "탑승지",
      "탑승",
      "#16a34a",
      `탑승 위치: ${route.boardingLabel || "탑승지"}<br>노선: ${route.shuttleBusName}`
    );
  }

  try {
    const dropoffLatLng = await geocodeAddress(route.dropoffForDraw);
    addMarker(
      dropoffLatLng,
      route.dropOffLabel || "하차지",
      "하차",
      "#22a34a",
      route.dropOffLabel || ""
    );
    bounds.extend(normalizeRoutePoint(dropoffLatLng));
  } catch (error) {
    console.warn("하차지 지오코딩 실패:", error.message);
  }

  const destinationMarkerPoint =
    route.walk2Minutes > 0
      ? destinationPlace.location
      : await geocodeAddress(route.destinationForDraw);

  addMarker(
    destinationMarkerPoint,
    destinationPlace.displayName || destinationPlace.formattedAddress || "목적지",
    "목적지",
    "#dc2626",
    destinationPlace.displayName || destinationPlace.formattedAddress || ""
  );

  bounds.extend(normalizeRoutePoint(currentPlace.location));
  bounds.extend(normalizeRoutePoint(boardingLatLng));
  bounds.extend(normalizeRoutePoint(destinationMarkerPoint));

  map.fitBounds(bounds);
}

async function resolvePlaceIfNeeded(type) {
  if (type === "current" && currentPlace) return currentPlace;
  if (type === "destination" && destinationPlace) return destinationPlace;

  const inputEl =
    type === "current"
      ? document.getElementById("currentInput")
      : document.getElementById("destinationInput");

  const text = inputEl.value.trim();
  if (!text) return null;

  const hotelCatalog = buildHotelCatalog(appData.routes);
  const matchedHotel = detectHotelByText(hotelCatalog, text);

  if (matchedHotel) {
    const geo = await geocodeAddress(matchedHotel.hotel_query);
    const lat = typeof geo.lat === "function" ? geo.lat() : geo.lat;
    const lng = typeof geo.lng === "function" ? geo.lng() : geo.lng;

    const resolved = {
      displayName: matchedHotel.hotel_display_name,
      formattedAddress: matchedHotel.hotel_query,
      location: { lat, lng },
    };

    if (type === "current") currentPlace = resolved;
    else destinationPlace = resolved;

    inputEl.value = matchedHotel.hotel_display_name;
    return resolved;
  }

  const geocodedLocation = await geocodeAddress(text);
  const lat = typeof geocodedLocation.lat === "function" ? geocodedLocation.lat() : geocodedLocation.lat;
  const lng = typeof geocodedLocation.lng === "function" ? geocodedLocation.lng() : geocodedLocation.lng;

  if (!isInsideMacau(lat, lng)) {
    throw new Error("출발지/목적지는 마카오 지역 내 장소만 선택할 수 있습니다.");
  }

  const resolved = {
    displayName: text,
    formattedAddress: text,
    location: { lat, lng },
  };

  if (type === "current") currentPlace = resolved;
  else destinationPlace = resolved;

  return resolved;
}

function swapPlaces() {
  const currentInput = document.getElementById("currentInput");
  const destinationInput = document.getElementById("destinationInput");

  const tempValue = currentInput.value;
  currentInput.value = destinationInput.value;
  destinationInput.value = tempValue;

  const tempPlace = currentPlace;
  currentPlace = destinationPlace;
  destinationPlace = tempPlace;
}

async function applyMapPickedLocation(type, latLng) {
  const lat = typeof latLng.lat === "function" ? latLng.lat() : latLng.lat;
  const lng = typeof latLng.lng === "function" ? latLng.lng() : latLng.lng;

  if (!isInsideMacau(lat, lng)) {
    alert("마카오 지역 내 위치만 선택할 수 있습니다.");
    return;
  }

  try {
    const placeData = await reverseGeocodeLatLng(latLng);
    const inputEl =
      type === "current"
        ? document.getElementById("currentInput")
        : document.getElementById("destinationInput");

    inputEl.value = placeData.displayName;
    if (type === "current") currentPlace = placeData;
    else destinationPlace = placeData;

    setMapPickMode(null);
  } catch (error) {
    console.error(error);
    alert(`지도 클릭 위치를 주소로 변환하지 못했습니다.\n${error.message}`);
  }
}

function setupBottomSheet() {
  const toggleBtn = document.getElementById("toggleSheetBtn");
  const collapseBtn = document.getElementById("collapseSheetBtn");
  const handle = document.getElementById("sheetHandle");
  const header = document.querySelector(".sheet-header");

  toggleBtn?.addEventListener("click", toggleSheetCollapse);
  collapseBtn?.addEventListener("click", toggleSheetCollapse);
  bindVerticalGesture([handle, header], {
    onSwipeUp: () => {
      if (sheetState === "collapsed") setSheetState("mid");
      else if (sheetState === "mid") setSheetState("expanded");
    },
    onSwipeDown: () => {
      if (sheetState === "expanded") setSheetState("mid");
      else if (sheetState === "mid") setSheetState("collapsed");
    },
    onTap: () => {
      if (sheetState === "expanded") setSheetState("mid");
      else toggleSheetCollapse();
    },
  });

  setSheetState("mid");
}

async function initMapAndAutocomplete() {
  await loadGoogleMapsScript();

  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 22.1666, lng: 113.5461 },
    zoom: 13,
    restriction: {
      latLngBounds: MACAU_BOUNDS,
      strictBounds: false,
    },
    streetViewControl: false,
    mapTypeControl: false,
    fullscreenControl: false,
  });

  map.addListener("click", async (event) => {
    if (!mapPickMode || isSearching) return;
    await applyMapPickedLocation(mapPickMode, event.latLng);
  });

  const currentInput = document.getElementById("currentInput");
  const destinationInput = document.getElementById("destinationInput");

  currentInput.setAttribute("autocomplete", "off");
  destinationInput.setAttribute("autocomplete", "off");

  currentAutocomplete = new google.maps.places.Autocomplete(currentInput, {
    fields: ["formatted_address", "geometry", "name"],
    componentRestrictions: { country: "MO" },
    bounds: MACAU_BOUNDS,
    strictBounds: true,
  });

  destinationAutocomplete = new google.maps.places.Autocomplete(destinationInput, {
    fields: ["formatted_address", "geometry", "name"],
    componentRestrictions: { country: "MO" },
    bounds: MACAU_BOUNDS,
    strictBounds: true,
  });

  currentAutocomplete.addListener("place_changed", () => {
    const place = currentAutocomplete.getPlace();
    const extracted = extractPlaceData(place);

    if (!extracted) {
      currentPlace = null;
      currentInput.value = "";
      alert("출발지는 마카오 지역 내 장소만 선택할 수 있습니다.");
      return;
    }

    currentPlace = extracted;
    currentInput.value = currentPlace.displayName || currentPlace.formattedAddress;
    setTimeout(() => {
      currentInput.blur();
      hideAutocompleteDropdown();
    }, 0);
  });

  destinationAutocomplete.addListener("place_changed", () => {
    const place = destinationAutocomplete.getPlace();
    const extracted = extractPlaceData(place);

    if (!extracted) {
      destinationPlace = null;
      destinationInput.value = "";
      alert("목적지는 마카오 지역 내 장소만 선택할 수 있습니다.");
      return;
    }

    destinationPlace = extracted;
    destinationInput.value = destinationPlace.displayName || destinationPlace.formattedAddress;
    setTimeout(() => {
      destinationInput.blur();
      hideAutocompleteDropdown();
    }, 0);
  });

  currentInput.addEventListener("input", () => {
    currentPlace = null;
  });

  destinationInput.addEventListener("input", () => {
    destinationPlace = null;
  });

  document.getElementById("myLocationBtn")?.addEventListener("click", () => {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;

        if (!isInsideMacau(lat, lng)) {
          alert("현재 위치가 마카오 외 지역으로 확인됩니다.");
          return;
        }

        map.panTo({ lat, lng });
        map.setZoom(16);

        try {
          const placeData = await reverseGeocodeLatLng({ lat, lng });
          currentPlace = placeData;
          document.getElementById("currentInput").value = placeData.displayName;
        } catch (error) {
          console.error(error);
        }
      },
      () => {
        alert("현재 위치를 가져오지 못했습니다.");
      }
    );
  });

  document.getElementById("centerMapBtn")?.addEventListener("click", () => {
    if (currentPlace?.location) {
      map.panTo(currentPlace.location);
      map.setZoom(15);
    } else {
      map.panTo({ lat: 22.1666, lng: 113.5461 });
      map.setZoom(13);
    }
  });
}

async function executeSearch() {
  selectedRouteIndex = 0;
  setSearchLoading(true);
  setMapPickMode(null);

  try {
    await resolvePlaceIfNeeded("current");
    await resolvePlaceIfNeeded("destination");

    if (!currentPlace) {
      alert("현재 위치 / 출발지를 입력하거나 자동완성 목록에서 선택해주세요.");
      return;
    }

    if (!destinationPlace) {
      alert("목적지를 입력하거나 자동완성 목록에서 선택해주세요.");
      return;
    }

    setSheetState("mid");
    dismissAutocompleteUi();
    collapseSearchPanel();

    if (currentMode === "bus") {
      renderBusPlaceholder();
      clearMapOverlays();
      return;
    }

    let results = [];

    if (currentMode === "walk") {
      results = await recommendWalkOnly(currentPlace, destinationPlace);
    } else {
      results = await recommendShuttleRoutes(
        appData.routes,
        appData.destinations,
        currentPlace,
        destinationPlace
      );
    }

    renderResults(results);

    if (results.length) {
      updateMapSummary(results[0], 1);
      await drawRecommendedRoute(results[0]);
    } else {
      clearMapOverlays();
      updateMapSummary(null);
    }
  } catch (error) {
    console.error(error);
    alert(`오류 발생: ${error.message}`);
  } finally {
    setSearchLoading(false);
  }
}

async function main() {
  appData = await loadAppData();
  setupBottomSheet();
  setupSearchPanel();
  await initMapAndAutocomplete();
  setMode("shuttle");

  const searchBtn = document.getElementById("searchBtn");
  const swapBtn = document.getElementById("swapBtn");
  const pickCurrentBtn = document.getElementById("pickCurrentBtn");
  const pickDestinationBtn = document.getElementById("pickDestinationBtn");
  const tabShuttle = document.getElementById("tabShuttle");
  const tabWalk = document.getElementById("tabWalk");
  const tabBus = document.getElementById("tabBus");

  swapBtn.addEventListener("click", () => {
    if (isSearching) return;
    swapPlaces();
  });

  pickCurrentBtn.addEventListener("click", () => {
    if (isSearching) return;
    expandSearchPanel();
    setMapPickMode(mapPickMode === "current" ? null : "current");
  });

  pickDestinationBtn.addEventListener("click", () => {
    if (isSearching) return;
    expandSearchPanel();
    setMapPickMode(mapPickMode === "destination" ? null : "destination");
  });

  tabShuttle.addEventListener("click", () => {
    if (isSearching) return;
    setMode("shuttle");
  });

  tabWalk.addEventListener("click", () => {
    if (isSearching) return;
    setMode("walk");
  });

  tabBus.addEventListener("click", () => {
    if (isSearching) return;
    setMode("bus");
    renderBusPlaceholder();
    updateMapSummary(null);
  });

  searchBtn.addEventListener("click", async () => {
    if (isSearching) return;
    await executeSearch();
  });
}

main().catch((error) => {
  console.error(error);
  alert(`초기화 중 오류가 발생했습니다.\n\n${error.message}`);
});
