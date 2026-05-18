const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function pluralize(value, singular, plural) {
  return value === 1 ? singular : plural;
}

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderStats(stats) {
  $("#eventCount").textContent = stats.eventCount;
  $("#instanceCount").textContent = stats.instanceCount;
  $("#latestReceivedAt").textContent = stats.latestReceivedAt ? formatDate(stats.latestReceivedAt) : "No events yet";
  $("#collectorStatus").textContent = stats.collectorStatus;
  $("#collectorStatus").className = "status-pill";
}

function renderFeatureChips(features) {
  if (!features || typeof features !== "object") {
    return `<span class="feature-chip muted">unknown</span>`;
  }

  const chips = Object.entries(features)
    .filter(([, value]) => value === true)
    .map(([flag]) => `<span class="feature-chip">${flag}</span>`);

  return chips.length > 0 ? chips.join("") : `<span class="feature-chip muted">none</span>`;
}

function renderTopCards(events) {
  const versionCounts = {};
  const platformCounts = {};

  events.forEach((event) => {
    versionCounts[event.version] = (versionCounts[event.version] || 0) + 1;
    platformCounts[event.platform] = (platformCounts[event.platform] || 0) + 1;
  });

  const topVersions = Object.entries(versionCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const topPlatforms = Object.entries(platformCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  $("#topVersions").innerHTML = topVersions
    .map((item) => `<li>${item[0]} <span>${item[1]} ${pluralize(item[1], "event", "events")}</span></li>`)
    .join("") || "<li>None yet</li>";

  $("#topPlatforms").innerHTML = topPlatforms
    .map((item) => `<li>${item[0]} <span>${item[1]} ${pluralize(item[1], "event", "events")}</span></li>`)
    .join("") || "<li>None yet</li>";
}

function renderTable(events) {
  const tableBody = $("#eventTableBody");
  tableBody.innerHTML = events
    .map((event) => {
      return `
      <tr>
        <td><code>${event.instanceId}</code></td>
        <td>${event.version}</td>
        <td>${event.platform}</td>
        <td class="feature-cell">${renderFeatureChips(event.features)}</td>
        <td>${formatDate(event.timestamp)}</td>
        <td>${formatDate(event.receivedAt)}</td>
      </tr>`;
    })
    .join("");

  if (!events.length) {
    tableBody.innerHTML = `<tr><td colspan="6" class="empty-state">No telemetry events match the current filter.</td></tr>`;
  }
}

function normalizeQuery(value) {
  return value.trim().toLowerCase();
}

function filterEvents(events, query, filterVersion, filterPlatform) {
  const normalizedQuery = normalizeQuery(query);

  return events.filter((event) => {
    const matchesQuery =
      !normalizedQuery ||
      event.instanceId.toLowerCase().includes(normalizedQuery) ||
      event.version.toLowerCase().includes(normalizedQuery) ||
      event.platform.toLowerCase().includes(normalizedQuery) ||
      JSON.stringify(event.features).toLowerCase().includes(normalizedQuery);

    const matchesVersion = !filterVersion || event.version === filterVersion;
    const matchesPlatform = !filterPlatform || event.platform === filterPlatform;

    return matchesQuery && matchesVersion && matchesPlatform;
  });
}

function syncFilters(events) {
  const versions = Array.from(new Set(events.map((event) => event.version))).sort();
  const platforms = Array.from(new Set(events.map((event) => event.platform))).sort();

  const versionSelect = $("#versionFilter");
  const platformSelect = $("#platformFilter");

  versionSelect.innerHTML = `<option value="">All versions</option>` +
    versions.map((version) => `<option value="${version}">${version}</option>`).join("");
  platformSelect.innerHTML = `<option value="">All platforms</option>` +
    platforms.map((platform) => `<option value="${platform}">${platform}</option>`).join("");
}

function renderSummaryBox(events) {
  $("#avgStepCount").textContent = events.length
    ? Math.round(events.reduce((sum, item) => sum + (item.features?.steps || 0), 0) / events.length)
    : 0;
}

function setupFilters(events) {
  const queryInput = $("#searchInput");
  const versionSelect = $("#versionFilter");
  const platformSelect = $("#platformFilter");

  const update = () => {
    const filteredEvents = filterEvents(
      events,
      queryInput.value,
      versionSelect.value,
      platformSelect.value
    );
    renderTable(filteredEvents);
  };

  queryInput.addEventListener("input", update);
  versionSelect.addEventListener("change", update);
  platformSelect.addEventListener("change", update);
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  if (!response.ok) {
    $("#loadError").textContent = "Failed to load telemetry data. Please reload or check login status.";
    $("#loadError").style.display = "block";
    return;
  }

  const data = await response.json();
  if (!data.ok) {
    $("#loadError").textContent = data.error || "Unable to read dashboard data.";
    $("#loadError").style.display = "block";
    return;
  }

  const events = data.events.map((event) => {
    let parsedFeatures = event.features;
    try {
      parsedFeatures = typeof event.features === "string" ? JSON.parse(event.features) : event.features;
    } catch (err) {
      parsedFeatures = event.features;
    }
    return {
      ...event,
      features: parsedFeatures,
    };
  });

  renderStats(data.stats);
  renderTopCards(events);
  renderTable(events);
  syncFilters(events);
  setupFilters(events);
}

window.addEventListener("DOMContentLoaded", () => {
  loadDashboard();
});
