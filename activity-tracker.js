/**
 * Activity Tracker Widget
 * Tracks page views, meaningful clicks, and form submissions across demo pages.
 * All browser storage and DOM updates are owned by this class.
 */
class ActivityTracker {
  /**
   * The demo pages already call `new ActivityTracker()` in their own scripts.
   * Returning the existing instance prevents duplicate listeners/page views while
   * allowing this file to initialize itself on DOMContentLoaded as required.
   * @param {{storageKey?: string, maxEvents?: number}} options
   */
  constructor(options = {}) {
    if (ActivityTracker.instance) return ActivityTracker.instance;

    this.storageKey = options.storageKey || "activity-tracker-data";
    this.maxEvents = Number.isSafeInteger(options.maxEvents) && options.maxEvents > 0
      ? options.maxEvents
      : 200;
    this.visibleEvents = 50;
    this.data = this._loadSession() || this._newSession();
    this.isOpen = this.data.ui.open;
    this.timelineNeedsRefresh = true;
    this.ui = null;
    this.durationTimer = null;

    ActivityTracker.instance = this;
    this._buildWidget();
    this._attachListeners();
    this.recordPageView();
    this._startDurationTimer();
  }

  /** Record exactly one page view each time a document loads. */
  recordPageView() {
    const page = this._pageName();
    this._recordEvent("pageview", page, page);
  }

  /** Start a new session without reloading the page. */
  resetSession() {
    this.data = this._newSession();
    this.data.ui.open = this.isOpen;
    this._saveSession();
    this._updateAllStats();
    this._renderTimeline();
  }

  /** Return a read-only snapshot useful for manual inspection/testing. */
  getSummary() {
    return {
      sessionId: this.data.sessionId,
      startedAt: this.data.startedAt,
      durationMs: Math.max(0, Date.now() - this.data.startedAt),
      stats: { ...this.data.stats },
      eventsCount: this.data.events.length,
      lastEventAt: this.data.events.length
        ? this.data.events[this.data.events.length - 1].time
        : this.data.startedAt,
    };
  }

  /** Create a session identifier that is distinct across page loads/tabs. */
  _newSession() {
    const now = Date.now();
    let randomPart;
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      randomPart = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } else {
      randomPart = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    }

    return {
      sessionId: `session_${now}_${randomPart}`,
      startedAt: now,
      events: [],
      // Counters are independent of the capped timeline, so historical totals
      // remain correct even after the oldest displayed events are removed.
      stats: { pageviews: 0, clicks: 0, forms: 0 },
      ui: { open: false },
    };
  }

  /**
   * Validate persisted data before using it. A malformed/old storage value
   * should never prevent the widget from loading.
   */
  _loadSession() {
    try {
      const raw = window.localStorage.getItem(this.storageKey);
      if (!raw) return null;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) return null;
      if (typeof saved.sessionId !== "string" || !/^session_\d+_[a-z0-9]+$/i.test(saved.sessionId)) return null;
      if (!Number.isFinite(saved.startedAt) || saved.startedAt <= 0
        || saved.startedAt > Date.now() + 60_000) return null;
      if (!Array.isArray(saved.events)) return null;

      const eventTypes = new Set(["pageview", "click", "form"]);
      const events = saved.events
        .filter((event) => event && typeof event === "object" && eventTypes.has(event.type)
          && Number.isFinite(event.time) && event.time > 0
          && event.time <= 8.64e15)
        .slice(-this.maxEvents)
        .map((event) => ({
          type: event.type,
          page: typeof event.page === "string" ? event.page.slice(0, 120) : "",
          details: typeof event.details === "string" ? event.details.slice(0, 160) : "",
          time: event.time,
        }));

      const counted = { pageviews: 0, clicks: 0, forms: 0 };
      for (const event of events) {
        counted[ActivityTracker.statForType[event.type]] += 1;
      }
      const stats = {};
      for (const key of Object.keys(counted)) {
        const oldValue = saved.stats && saved.stats[key];
        stats[key] = Number.isSafeInteger(oldValue) && oldValue >= counted[key]
          ? oldValue
          : counted[key];
      }

      return {
        sessionId: saved.sessionId,
        startedAt: saved.startedAt,
        events,
        stats,
        ui: { open: saved.ui?.open === true },
      };
    } catch (_error) {
      // Invalid JSON, blocked storage, and disabled cookies all fall back to memory.
      return null;
    }
  }

  /** Persist the entire session immediately after each recorded activity. */
  _saveSession() {
    this.data.ui.open = this.isOpen;
    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.data));
    } catch (_error) {
      // Browsers can deny storage in private/restricted contexts; in-memory
      // tracking continues without breaking the page.
    }
  }

  /** Save and display one activity with minimal DOM work. */
  _recordEvent(type, page, details) {
    const event = {
      type,
      page: page || this._pageName(),
      details: String(details || "").slice(0, 160),
      time: Date.now(),
    };
    this.data.events.push(event);
    if (this.data.events.length > this.maxEvents) this.data.events.shift();

    const key = ActivityTracker.statForType[type];
    this.data.stats[key] += 1;
    this._saveSession();

    if (this.ui) {
      this.ui.stats[key].textContent = String(this.data.stats[key]);
      if (this.isOpen) {
        if (this.timelineNeedsRefresh) this._renderTimeline();
        else this._prependTimelineItem(event);
      } else {
        this.timelineNeedsRefresh = true;
      }
    }
  }

  /** Use capture-phase delegation: one listener for all page clicks/submits. */
  _attachListeners() {
    document.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || event.target.closest(".atw")) return;
      const target = event.target.closest(
        'button, a, input, select, textarea, [role="button"], [data-track]'
      );
      if (!target) return;
      this._recordEvent("click", this._pageName(), this._describeElement(target));
    }, true);

    document.addEventListener("submit", (event) => {
      if (!(event.target instanceof HTMLFormElement) || event.target.closest(".atw")) return;
      const form = event.target;
      const name = form.getAttribute("name") || form.id || "form";
      // Do not collect entered values or personal information from the form.
      this._recordEvent("form", this._pageName(), `${name} submitted`);
    }, true);

    // The widget's controls are intentionally not included in activity counts.
    this.ui.root.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest(".atw__toggle")) {
        this._setTimelineOpen(!this.isOpen);
      } else if (event.target.closest(".atw__reset")) {
        this.resetSession();
      }
    });
  }

  /** Build the widget once. Markup is static; activity text uses textContent. */
  _buildWidget() {
    const root = document.createElement("aside");
    root.className = "atw";
    root.setAttribute("aria-label", "Activity Tracker");
    root.innerHTML = `
      <section class="atw__panel">
        <div class="atw__header">
          <div class="atw__title"><span class="atw__dot" aria-hidden="true"></span>Activity Tracker</div>
          <div class="atw__actions">
            <button type="button" class="atw__btn atw__toggle" aria-controls="atw-timeline-wrap">Show</button>
            <button type="button" class="atw__btn atw__reset" title="Reset session">Reset</button>
          </div>
        </div>
        <div class="atw__stats" aria-label="Activity statistics">
          <div class="atw__stat"><span class="atw__statLabel">Pages</span><span class="atw__statValue" data-atw-stat="pageviews">0</span></div>
          <div class="atw__stat"><span class="atw__statLabel">Clicks</span><span class="atw__statValue" data-atw-stat="clicks">0</span></div>
          <div class="atw__stat"><span class="atw__statLabel">Forms</span><span class="atw__statValue" data-atw-stat="forms">0</span></div>
          <div class="atw__stat"><span class="atw__statLabel">Duration</span><span class="atw__statValue" data-atw-stat="duration">0s</span></div>
        </div>
        <div class="atw__timelineWrap atw__hidden" id="atw-timeline-wrap" hidden>
          <div class="atw__timeline" role="list" aria-label="Activity timeline"></div>
        </div>
      </section>`;
    document.body.appendChild(root);

    this.ui = {
      root,
      panel: root.querySelector(".atw__panel"),
      toggle: root.querySelector(".atw__toggle"),
      timelineWrap: root.querySelector(".atw__timelineWrap"),
      timeline: root.querySelector(".atw__timeline"),
      stats: {
        pageviews: root.querySelector('[data-atw-stat="pageviews"]'),
        clicks: root.querySelector('[data-atw-stat="clicks"]'),
        forms: root.querySelector('[data-atw-stat="forms"]'),
        duration: root.querySelector('[data-atw-stat="duration"]'),
      },
    };
    this._updateAllStats();
    this._setTimelineOpen(this.isOpen, false);
  }

  /** Only regenerate timeline when opened or reset. */
  _setTimelineOpen(open, persist = true) {
    this.isOpen = Boolean(open);
    this.ui.panel.classList.toggle("is-open", this.isOpen);
    this.ui.panel.classList.toggle("is-closed", !this.isOpen);
    this.ui.timelineWrap.hidden = !this.isOpen;
    this.ui.timelineWrap.classList.toggle("atw__hidden", !this.isOpen);
    this.ui.toggle.textContent = this.isOpen ? "Hide" : "Show";
    this.ui.toggle.setAttribute("aria-expanded", String(this.isOpen));
    if (this.isOpen && this.timelineNeedsRefresh) this._renderTimeline();
    if (persist) this._saveSession();
  }

  /** Use a DocumentFragment to batch additions and avoid innerHTML injection. */
  _renderTimeline() {
    const fragment = document.createDocumentFragment();
    const latest = this.data.events.slice(-this.visibleEvents).reverse();
    for (const event of latest) fragment.appendChild(this._makeTimelineItem(event));
    this.ui.timeline.replaceChildren(fragment);
    this.timelineNeedsRefresh = false;
  }

  /** Constant-time incremental rendering while the timeline is visible. */
  _prependTimelineItem(event) {
    this.ui.timeline.prepend(this._makeTimelineItem(event));
    if (this.ui.timeline.childElementCount > this.visibleEvents) {
      this.ui.timeline.lastElementChild.remove();
    }
  }

  _makeTimelineItem(event) {
    const item = document.createElement("div");
    item.className = "atw__event";
    item.setAttribute("role", "listitem");

    const time = document.createElement("time");
    time.className = "atw__eventTime";
    time.dateTime = new Date(event.time).toISOString();
    time.textContent = new Date(event.time).toLocaleTimeString([], {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const body = document.createElement("div");
    body.className = "atw__eventBody";
    const type = document.createElement("div");
    type.className = "atw__eventType";
    type.textContent = event.type;
    const details = document.createElement("div");
    details.className = "atw__eventMeta";
    details.textContent = [event.page, event.details].filter(Boolean).join(" — ");
    body.append(type, details);
    item.append(time, body);
    return item;
  }

  _updateAllStats() {
    for (const key of ["pageviews", "clicks", "forms"]) {
      this.ui.stats[key].textContent = String(this.data.stats[key]);
    }
    this._updateDuration();
  }

  _updateDuration() {
    this.ui.stats.duration.textContent = this._formatDuration(Date.now() - this.data.startedAt);
  }

  _startDurationTimer() {
    if (this.durationTimer !== null) return;
    this.durationTimer = window.setInterval(() => this._updateDuration(), 1000);
  }

  _pageName() {
    const path = window.location.pathname.split("/").filter(Boolean);
    return path[path.length - 1] || "index.html";
  }

  _describeElement(element) {
    const tag = element.tagName.toLowerCase();
    const id = element.id ? `#${element.id}` : "";
    const tracked = element.getAttribute("data-track");
    let label = (element.getAttribute("aria-label")
      || (tag === "input" || tag === "textarea" || tag === "select"
        ? (element.getAttribute("name") || element.getAttribute("placeholder"))
        : element.textContent)
      || "").trim().replace(/\s+/g, " ").slice(0, 90);
    if (!label) label = element.getAttribute("title") || element.getAttribute("type") || "";
    return [tag + id, tracked ? `track:${tracked}` : "", label ? `label:${label}` : ""]
      .filter(Boolean).join(" | ");
  }

  _formatDuration(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = seconds % 60;
    if (hours) return `${hours}h ${minutes}m ${remaining}s`;
    if (minutes) return `${minutes}m ${remaining}s`;
    return `${remaining}s`;
  }
}

ActivityTracker.instance = null;
ActivityTracker.statForType = Object.freeze({
  pageview: "pageviews", click: "clicks", form: "forms",
});

// Keep compatibility with the unmodified demo HTML's existing constructors.
if (typeof window !== "undefined") window.ActivityTracker = ActivityTracker;
if (typeof module !== "undefined" && module.exports) module.exports = ActivityTracker;

// Instantiation is required on DOMContentLoaded. Also supports late script loads.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => new ActivityTracker(), { once: true });
  } else {
    new ActivityTracker();
  }
}
