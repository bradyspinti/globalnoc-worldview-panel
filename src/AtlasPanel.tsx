import React, { Component } from 'react';
import { PanelProps, SelectableValue, urlUtil } from '@grafana/data';
import { SimpleOptions } from 'types';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import { Select, Icon } from '@grafana/ui';
import { cx } from 'emotion';
import { getMapSelectorTheme } from './util/MapSelector';
// @ts-ignore
import AtlasOptions from './config/AtlasOptions.js';
// @ts-ignore
import Atlas from './lib/Atlas4.js';
import { config } from '@grafana/runtime';

interface Props extends PanelProps<SimpleOptions> {}

interface AtlasPanelState {
  mapID: string;
  mapWrapperID: string;
  atlas: any;
  mapSelectorDisplay: boolean;
  groupFilter: Array<{ label: string; value: string }>;
  subGroupFilter: Array<{ label: string; value: string }>;
  groupSelectorDisplay: boolean;
  searchQuery: string;
  searchResults: Array<{ id: string; label: string; lat: number; lng: number; _point: any }>;
  searchOpen: boolean;
  highlightedEndpoint: string | null;
  selectedTimeIndex: number;
  isPlaying: boolean;
  availableTimestamps: number[];
}

interface FetchSession {
  [key: string]: string;
}

interface DataValue {
  aggregate_group: string;
  data_target: string;
  values: Array<[number, number]>;
}

interface DataMappingOptions {
  dataTarget: string;
  [key: string]: any;
}

let editFromPanel = false;
let fetchSession: FetchSession = {};
let mapUpdated = false;
let lastDataDictionaryCreated = '';
let dataValues: DataValue[] = [];
let endpointGroupMap: { [id: string]: string[] } = {};
// @ts-ignore
let styles = getMapSelectorTheme(config.theme);
let playbackTimer: ReturnType<typeof setInterval> | null = null;

export class AtlasPanel extends Component<Props, AtlasPanelState> {
  constructor(props: Props) {
    super(props);
    this.state = {
      mapID: 'a' + uuidv4(),
      mapWrapperID: 'b' + uuidv4(),
      atlas: undefined,
      mapSelectorDisplay: false,
      groupFilter: [],
      subGroupFilter: [],
      groupSelectorDisplay: false,
      searchQuery: '',
      searchResults: [],
      searchOpen: false,
      highlightedEndpoint: null,
      selectedTimeIndex: -1,
      isPlaying: false,
      availableTimestamps: [],
    };
    this.setLayerDisplay      = this.setLayerDisplay.bind(this);
    this.handleSearchChange   = this.handleSearchChange.bind(this);
    this.handleSearchSelect   = this.handleSearchSelect.bind(this);
    this.handleScrubberChange = this.handleScrubberChange.bind(this);
    this.togglePlayback       = this.togglePlayback.bind(this);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  componentDidMount() {
    const atlas = new Atlas(this.state.mapID, AtlasOptions);
    this.setState({ atlas }, () => {
      this.atlasInitialized();
      this.configureAtlasEditorDisplay();
    });
  }

  componentWillUnmount() {
    this.stopPlayback();
  }

  shouldComponentUpdate(nextProps: any, nextState: AtlasPanelState) {
    if (
      nextProps.options.mapType !== this.props.options.mapType ||
      JSON.stringify(nextProps.options.mapURLs) !== JSON.stringify(this.props.options.mapURLs)
    ) {
      mapUpdated = true;
    }
    return true;
  }

  componentDidUpdate() {
    if (this.state.atlas) {
      this.state.atlas.map.invalidateSize();
      // @ts-ignore
      window.atlas = this.state.atlas;
    }
    this.configureAtlasEditorDisplay();
    if (editFromPanel) {
      editFromPanel = false;
      return;
    }
    if (mapUpdated) {
      this.setMapFromOptions();
    } else {
      mapUpdated = false;
    }
    this.setMapView();
    this.setMapTile();
    this.setWeatherTile();
    this.setLegendConfiguration();
    this.setTopologyOptions();
    this.setTopologyData();
  }

  atlasInitialized() {
    this.setListeners();
    this.setMapFromOptions();
    this.setMapView();
    this.setMapTile();
    this.setWeatherTile();
    this.setLegendConfiguration();
    this.setTopologyData();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LISTENERS
  // ═══════════════════════════════════════════════════════════════════════════

  setListeners() {
    this.setUpdateListeners();
    this.setMapViewUpdateListeners();
    this.setTopologyUpdateListeners();
  }

  setMapViewUpdateListeners() {
    const { atlas } = this.state;
    atlas.map.on('moveend dragend', () => {
      const center  = atlas.map.getCenter();
      const mapView = { ...this.props.options.mapView };
      mapView.lat  = center.lat.toFixed(4);
      mapView.lng  = center.lng.toFixed(4);
      mapView.zoom = atlas.map.getZoom();
      editFromPanel = true;
      this.props.onOptionsChange({ ...this.props.options, mapView });
    });
  }

  setUpdateListeners() {
    const { atlas } = this.state;
    atlas.on('update', () => {
      const { mapType } = this.props.options;
      const json        = atlas.getJSON();
      const options     = this.props.options;
      options.customMapJSON = { content: JSON.stringify(json[0], null, 2), mode: 'json' };
      editFromPanel = true;
      if (mapType === 'custom') {
        this.props.onOptionsChange({ ...options });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MAP SETUP
  // ═══════════════════════════════════════════════════════════════════════════

  setMapFromOptions() {
    const { mapType } = this.props.options;
    if (mapType === 'custom') {
      this.setCustomMap();
    } else {
      this.setURLMap();
    }
  }

  setURLMap() {
    const { atlas }     = this.state;
    const { mapURLs }   = this.props.options;
    const { lat, lng }  = this.props.options.mapView;
    const reinforceView = this.reinforceView.bind(this);
    const setData       = this.setTopologyData.bind(this);
    const buildGroupMap = this.buildEndpointGroupMap.bind(this);

    atlas.editor.disableAllModes();
    const editorButton = document.querySelector('.atlas-toggle-editor') as HTMLAnchorElement;
    if (editorButton) { editorButton.style.display = 'none'; }
    if (atlas.editor.sidebar.sbContainer) {
      atlas.editor.hideToolbar();
      atlas.editor.hideSidebar();
    }
    atlas.removeAllTopologies();

    for (const id in mapURLs) {
      const sessionID = uuidv4();
      fetchSession[mapURLs[id].url] = sessionID;
      fetchMaps(mapURLs[id], sessionID);
    }

    async function fetchMaps(mapURL: any, sessionID: string) {
      const { url, name, display } = mapURL;
      if (url === '') { return; }
      try {
        const request  = await fetch(url);
        const atlasObj = await request.json();
        if (sessionID === fetchSession[url]) {
          buildGroupMap(atlasObj);
          for (const map of atlasObj) {
            map.metadata.mb_url        = url;
            map.metadata.grafana_alias = name;
            atlas.addTopology(map);
            setTimeout(() => { setData(); }, 100);
            if (!display) { atlas.hideTopology(map.name); }
            reinforceView(lat, lng);
          }
        }
      } catch (error) {
        console.error('Error loading map from URL:', url, error);
      }
    }
  }

  reinforceView(lat: number | string, lng: number | string) {
    this.state.atlas.map.setView({ lat: parseFloat(lat as string), lng: parseFloat(lng as string) });
  }

  setCustomMap() {
    const { atlas }         = this.state;
    const { customMapJSON } = this.props.options;
    const reinforceView     = this.reinforceView.bind(this);
    const setData           = this.setTopologyData.bind(this);
    const { lat, lng }      = this.props.options.mapView;
    let topology: any;

    try {
      topology = JSON.parse(customMapJSON.content);
    } catch (e) {
      console.error('Unable to parse JSON data from Panel Options Editor');
    }

    const editorButton = document.querySelector('.atlas-toggle-editor') as HTMLAnchorElement;
    if (editorButton) { editorButton.style.display = ''; }

    if (topology) {
      this.buildEndpointGroupMap(topology);
      atlas.editor.disableAllModes();
      if (atlas.editor.sidebar.sbContainer) {
        atlas.editor.hideToolbar();
        atlas.editor.hideSidebar();
      }
      atlas.removeAllTopologies();
      if (Array.isArray(topology)) {
        for (const topo of topology) { atlas.addTopology(topo); }
      } else {
        atlas.addTopology(topology);
      }
      setTimeout(() => {
        try { setData(); } catch (error) { console.error('Could not set data :(', error); }
      }, 100);
      reinforceView(lat, lng);
    }
  }

  setMapView() {
    const { atlas }          = this.state;
    const { lat, lng, zoom } = this.props.options.mapView;
    atlas.map.setZoom(zoom);
    const setViewAfterZoom = () => {
      atlas.map.setView({ lat: parseFloat(lat as string), lng: parseFloat(lng as string) });
    };
    atlas.map.on('zoomend', setViewAfterZoom);
    const moveEndListener = () => {
      atlas.map.off('zoomend', setViewAfterZoom);
      atlas.map.off('moveend', moveEndListener);
    };
    atlas.map.on('moveend', moveEndListener);
  }

  setMapTile() {
    const { atlas }             = this.state;
    let { mapTile, mapTileURL } = this.props.options;
    if (!mapTileURL) { mapTileURL = ''; }
    if (mapTile) { atlas.addTile({ url: mapTileURL, maxZoom: 20, name: 'custom' }); }
    mapTile ? atlas.showTile('custom') : atlas.showTile('map');
  }

  setWeatherTile() {
    const { atlas }       = this.state;
    const { weatherTile } = this.props.options;
    if (weatherTile) {
      atlas.showOverlayTile('weather');
      atlas.redrawOverlayTiles();
    } else {
      atlas.hideOverlayTile('weather');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  GROUP FILTER
  // ═══════════════════════════════════════════════════════════════════════════

  getAllParentGroups() {
    const { atlas } = this.state;
    const parents   = new Set<string>();
    if (!atlas) { return []; }
    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((l: any) => {
        const g      = l.metadata?.group;
        const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);
        groups.forEach((grp) => {
          const parent = grp.includes(':') ? grp.split(':')[0] : grp;
          parents.add(parent);
        });
      });
    }
    return [...parents].map(g => ({ label: g, value: g }));
  }

  getSubGroups(selectedParents: string[]) {
    const { atlas } = this.state;
    const subs      = new Set<string>();
    if (!atlas) { return []; }
    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((l: any) => {
        const g      = l.metadata?.group;
        const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);
        groups.forEach((grp) => {
          if (!grp.includes(':')) { return; }
          const [parent, child] = grp.split(':');
          if (selectedParents.length === 0 || selectedParents.includes(parent)) {
            if (child) { subs.add(child); }
          }
        });
      });
    }
    return [...subs].map(g => ({ label: g, value: g }));
  }

  applyGroupFilterAdvanced(selectedParents: string[], selectedSubs: string[]) {
    const { atlas } = this.state;
    if (!atlas) { return; }
    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((l: any) => {
        const g      = l.metadata?.group;
        const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);
        const visible =
          groups.length === 0 ||
          groups.some((grp) => {
            if (!grp.includes(':')) {
              return selectedParents.length === 0 || selectedParents.includes(grp);
            }
            const [parent, child] = grp.split(':');
            const parentMatch = selectedParents.length === 0 || selectedParents.includes(parent);
            const childMatch  = selectedSubs.length === 0  || selectedSubs.includes(child);
            return parentMatch && childMatch;
          });
        try { visible ? l.show() : l.hide(); } catch (_) {}
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  LEGEND + TOPOLOGY
  // ═══════════════════════════════════════════════════════════════════════════

  setLegendConfiguration() {
    const { atlas }  = this.state;
    const { legend } = this.props.options;
    atlas.changeLegendProperty('lines', 'type',  legend.type);
    atlas.changeLegendProperty('lines', 'units', legend.unit);
    atlas.changeLegendValues('lines', legend.threshold, legend.colors);
    if (legend.display) {
      atlas.legends.lines.show();
      atlas.changeLegendProperty('lines', 'orientation', legend.orientation);
      atlas.changeLegendProperty('lines', 'size', legend.size + '%');
      const labelBar = atlas.legends.lines.labelBar as HTMLDivElement;
      (Array.from(labelBar.children) as HTMLDivElement[]).forEach(
        (label) => { label.style.color = legend.textColor; }
      );
    } else {
      atlas.legends.lines.hide();
    }
  }

  setDataMappingOptions() {
    const dataMappings = this.props.options.dataMappings as unknown as DataMappingOptions;
    const { atlas }    = this.state;
    for (const property in dataMappings) {
      atlas.changeCircuitColoringProperties(property, dataMappings[property]);
    }
  }

  setTopologyUpdateListeners() {
    const { atlas } = this.state;
    atlas.on('topology-added', () => { this.setTopologyHelper(); });
  }

  setTopologyOptions() { this.setTopologyHelper(); }

  setTopologyHelper() {
    const { atlas }       = this.state;
    const topologyOptions = this.props.options.topology;
    for (const t in atlas.topologies) {
      const topology = atlas.topologies[t];
      topology.points.forEach((p: any) => {
        p.color = topologyOptions.point.color;
        p.fill  = topologyOptions.point.color;
        const display       = topologyOptions.point.tooltip.display;
        const staticTooltip = topologyOptions.point.tooltip.static;
        if (display) { p.tooltip.html = topologyOptions.point.tooltip.content; p.tooltip.update('html'); }
        if (display && staticTooltip) { p.makeStatic(true); } else { p.makeStatic(false); }
        display ? p.showToolTip() : p.hideToolTip();
        p.update();
      });
      topology.lines.forEach((l: any) => {
        l.options.color = topologyOptions.line.color;
        const display   = topologyOptions.line.tooltip.display;
        if (display) { l.tooltip.html = topologyOptions.line.tooltip.content; l.tooltip.update('data'); }
        display ? l.showToolTip() : l.hideToolTip();
        try { l.update('style'); } catch (error) {}
      });
    }
  }

  buildEndpointGroupMap(topologyObj: any) {
    const topo = Array.isArray(topologyObj) ? topologyObj : [topologyObj];
    topo.forEach((t: any) => {
      const endpoints = t.endpoints || {};
      Object.keys(endpoints).forEach(id => {
        const ep = endpoints[id];
        const g  = ep.group ?? ep.metadata?.group;
        if (g) { endpointGroupMap[id] = Array.isArray(g) ? g : [g]; }
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TEMPORAL HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  getValueAtTime(values: Array<[number, number]>, targetTimestamp: number): number | null {
    if (!values || values.length === 0) { return null; }
    let lo = 0, hi = values.length - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (values[mid][0] < targetTimestamp) { lo = mid + 1; } else { hi = mid; }
    }
    if (lo > 0 && Math.abs(values[lo - 1][0] - targetTimestamp) < Math.abs(values[lo][0] - targetTimestamp)) {
      lo = lo - 1;
    }
    return values[lo][1];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA
  // ═══════════════════════════════════════════════════════════════════════════

  private calcAggregate(vals: number[], mode: string): number {
    if (vals.length === 0) { return 0; }
    switch (mode) {
      case 'chooseSum': return vals.reduce((a, b) => a + b, 0);
      case 'chooseAvg': return vals.reduce((a, b) => a + b, 0) / vals.length;
      case 'chooseMin': return Math.min(...vals);
      case 'chooseMax': return Math.max(...vals);
      default:          return vals[0];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  addDataToCircuits — THE KEY FIX FOR SUM/AVG
  //
  //  Atlas4.js only natively understands 'chooseMax' and 'chooseMin' as
  //  dataTarget values.  Passing 'chooseSum' or 'chooseAvg' to
  //  changeCircuitColoringProperties falls through to a no-op branch inside
  //  Atlas, so lines stay grey.
  //
  //  The fix for sum/avg:
  //    1. Compute the aggregated scalar ourselves per line per group.
  //    2. Write the result directly onto each line object's internal data
  //       fields (appliedData, dataValues) that Atlas reads when painting.
  //    3. Force the line's color by calling its own colorize/update method
  //       directly, bypassing Atlas's dataTarget routing entirely.
  //    4. Also feed a synthetic chooseMax-compatible dataValues array through
  //       applyData as a backup so Atlas's batch pass picks it up too.
  // ─────────────────────────────────────────────────────────────────────────
  addDataToCircuits() {
    console.error("test")
    const { atlas }   = this.state;
    const { options } = this.props;
    const { selectedTimeIndex, availableTimestamps } = this.state;

    if (!atlas || !dataValues || dataValues.length === 0) { return; }

    const useLatest       = selectedTimeIndex === -1 || availableTimestamps.length === 0;
    const targetTimestamp = useLatest ? null : availableTimestamps[selectedTimeIndex];
    const selection       = options.dataMappings.dataTarget;

    const isCustomAggregate = selection === 'chooseSum' || selection === 'chooseAvg';

    // Shared: get a single scalar from a DataValue entry at the right time
    const getScalar = (dv: DataValue): number | null => {
      if (!dv.values.length) { return null; }
      return useLatest || targetTimestamp === null
        ? dv.values[dv.values.length - 1]?.[1] ?? null
        : this.getValueAtTime(dv.values, targetTimestamp);
    };

    // Shared: format a value for tooltips
    const units = atlas.legends?.lines?.units || '';
    const fmt = (v: number | null): string => {
      if (v === null || v === undefined) { return '0'; }
      if (v >= 1000 && (units.toLowerCase().includes('bps') || units.toLowerCase().includes('bit'))) {
        if (v >= 1_000_000_000) { return `${(v / 1_000_000_000).toFixed(2)} Gbps`; }
        if (v >= 1_000_000)     { return `${(v / 1_000_000).toFixed(2)} Mbps`; }
        if (v >= 1_000)         { return `${(v / 1_000).toFixed(2)} Kbps`; }
      }
      return (v < 1000 || !units.toLowerCase().includes('bps'))
        ? v.toFixed(0)
        : `${v.toFixed(2)} ${units}`;
    };

    if (!isCustomAggregate) {
      // ── NATIVE PATH (chooseMax / chooseMin / named group) ─────────────────
      if (useLatest || targetTimestamp === null) {
        atlas.applyData(dataValues);
      } else {
        const sliced = dataValues.map(dv => ({
          ...dv,
          values: ((): Array<[number, number]> => {
            const v = this.getValueAtTime(dv.values, targetTimestamp);
            return v !== null ? [[targetTimestamp, v]] : [];
          })(),
        }));
        atlas.applyData(sliced);
      }
      this.setDataMappingOptions();

      // Update tooltips
      try {
        for (const t in atlas.topologies) {
          atlas.topologies[t].lines.forEach((line: any) => {
            try {
              const dataTargets = line.metadata?.data_targets;
              if (!dataTargets || !Array.isArray(dataTargets) || dataTargets.length === 0) { return; }
              let inVal = 0, outVal = 0;
              dataTargets.forEach((targetName: string) => {
                const md = dataValues.find((dv: any) => dv.data_target === targetName);
                if (!md || !md.values.length) { return; }
                const raw = useLatest || targetTimestamp === null
                  ? md.values[md.values.length - 1]?.[1] ?? null
                  : this.getValueAtTime(md.values, targetTimestamp);
                if (raw === null) { return; }
                const grp = md.aggregate_group?.toLowerCase() || '';
                if (grp.includes('in'))  { inVal  = raw; }
                if (grp.includes('out')) { outVal = raw; }
              });
              if (line.tooltip && options.topology.line.tooltip.content) {
                line.tooltip.html = options.topology.line.tooltip.content
                  .replace(/\$dataValues\.input\.now/g,  fmt(inVal))
                  .replace(/\$dataValues\.output\.now/g, fmt(outVal));
                line.tooltip.update('html');
              }
            } catch (_) {}
          });
        }
      } catch (_) {}
      return;
    }

    // ── CUSTOM AGGREGATE PATH (chooseSum / chooseAvg) ─────────────────────
    //
    // We cannot rely on Atlas's dataTarget routing here because it doesn't
    // know about sum/avg.  Instead we:
    //   1. Compute per-group aggregates for every line manually.
    //   2. Force Atlas to use chooseMax via changeCircuitColoringProperties
    //      so its colour engine IS active.
    //   3. Feed a synthetic dataValues array where every series has already
    //      been reduced to a single pre-computed value — so when Atlas runs
    //      its chooseMax pass it trivially picks that one value.
    //   4. As a belt-and-suspenders measure, also directly set each line's
    //      internal data fields and call its update method.

    const now = Date.now();

    // Build map: data_target -> aggregated scalar
    const aggregatedByTarget = new Map<string, number>();

    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((line: any) => {
        const dataTargets: string[] = line.metadata?.data_targets;
        if (!dataTargets || !Array.isArray(dataTargets) || dataTargets.length === 0) { return; }

        // Bucket scalars by aggregate_group for THIS line
        const buckets: { [grp: string]: number[] } = {};
        dataTargets.forEach((targetName: string) => {
          const dv = dataValues.find(d => d.data_target === targetName);
          if (!dv) { return; }
          const scalar = getScalar(dv);
          if (scalar === null) { return; }
          const grp = dv.aggregate_group || '__default__';
          if (!buckets[grp]) { buckets[grp] = []; }
          buckets[grp].push(scalar);
        });

        // Store aggregated result per target
        dataTargets.forEach((targetName: string) => {
          const dv = dataValues.find(d => d.data_target === targetName);
          if (!dv) { return; }
          const grp  = dv.aggregate_group || '__default__';
          const vals = buckets[grp] || [];
          aggregatedByTarget.set(targetName, this.calcAggregate(vals, selection));
        });
      });
    }

    // Step 1: tell Atlas to use chooseMax so its colour engine activates
    atlas.changeCircuitColoringProperties('dataTarget', 'chooseMax');

    // Step 2: build synthetic dataValues where every series = one pre-computed point
    const syntheticDataValues: DataValue[] = dataValues.map(dv => ({
      data_target:     dv.data_target,
      aggregate_group: dv.aggregate_group,
      values:          [[now, aggregatedByTarget.has(dv.data_target)
        ? aggregatedByTarget.get(dv.data_target)!
        : (getScalar(dv) ?? 0)] as [number, number]],
    }));

    // Step 3: apply through Atlas's normal pipeline
    try { atlas.applyData(syntheticDataValues); } catch (e) {
      console.error('[Atlas] applyData failed for custom aggregate:', e);
    }

    // Step 4: belt-and-suspenders — directly set internal data on each line
    // and force a style update so the colour definitely applies even if
    // applyData's internal routing doesn't reach it.
    try {
      for (const t in atlas.topologies) {
        atlas.topologies[t].lines.forEach((line: any) => {
          try {
            const dataTargets: string[] = line.metadata?.data_targets;
            if (!dataTargets || !Array.isArray(dataTargets) || dataTargets.length === 0) { return; }

            let inVal = 0, outVal = 0;
            let dominantVal = 0;

            dataTargets.forEach((targetName: string) => {
              const dv  = dataValues.find(d => d.data_target === targetName);
              if (!dv) { return; }
              const val = aggregatedByTarget.get(targetName) ?? 0;
              const grp = dv.aggregate_group?.toLowerCase() || '';
              if (grp.includes('in') && !grp.includes('out')) { inVal = val; }
              if (grp.includes('out'))                        { outVal = val; }
              if (val > dominantVal) { dominantVal = val; }
            });

            // Write every internal field Atlas might read for colouring
            line.appliedData = { now: dominantVal };
            line.dataValues  = {
              input:  { now: inVal  },
              output: { now: outVal },
            };

            // Force a style update on the line
            if (typeof line.update === 'function') {
              try { line.update('style'); } catch (_) {}
              try { line.update('data');  } catch (_) {}
              try { line.update();        } catch (_) {}
            }
            if (typeof line.colorize === 'function') {
              try { line.colorize(); } catch (_) {}
            }
            if (typeof line.applyColor === 'function') {
              try { line.applyColor(); } catch (_) {}
            }

            // Tooltip
            if (line.tooltip && options.topology.line.tooltip.content) {
              line.tooltip.html = options.topology.line.tooltip.content
                .replace(/\$dataValues\.input\.now/g,  fmt(inVal))
                .replace(/\$dataValues\.output\.now/g, fmt(outVal));
              line.tooltip.update('html');
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
  }

  setTopologyData() {
    const { data } = this.props;
    if (data.state === 'Done' && lastDataDictionaryCreated !== data.request!.requestId) {
      this.createDataDictionary();
    }
    this.addDataToCircuits();
  }

  createDataDictionary() {
    const { series, request } = this.props.data;
    lastDataDictionaryCreated = request!.requestId;
    dataValues = [];

    let data_aggregates = this.props.options.dataAggregateGroups;
    if (data_aggregates.length === 0) {
      data_aggregates.push({ aggregate_group: 'data', pattern: '.*' });
    }

    for (const seriesItem of series) {
      try {
        const data_target: string = seriesItem.name!;

        let timeField = seriesItem.fields.find((f: any) => f.type === 'time')
          || seriesItem.fields.find((f: any) => f.name?.toLowerCase() === 'time')
          || seriesItem.fields[0];

        let valField = seriesItem.fields.find((f: any) => f.type === 'number')
          || seriesItem.fields.find((f: any) => f.name?.toLowerCase() === 'value')
          || seriesItem.fields[1];

        if (!timeField || !valField) { continue; }

        const rawTime   = typeof timeField.values?.toArray === 'function'
          ? timeField.values.toArray()
          : (Array.isArray(timeField.values) ? timeField.values : []);
        const rawValues = typeof valField.values?.toArray === 'function'
          ? valField.values.toArray()
          : (Array.isArray(valField.values) ? valField.values : []);

        const timestamps: number[] = rawTime   as number[];
        const speeds:     number[] = rawValues as number[];

        const values: Array<[number, number]> = timestamps
          .map((ts, i) => [ts, speeds[i]] as [number, number])
          .sort((a, b) => a[0] - b[0]);

        let aggregate_group: string | undefined;
        for (const aggregates of data_aggregates) {
          if (!aggregates.pattern) { continue; }
          if (new RegExp(aggregates.pattern).test(data_target)) {
            aggregate_group = aggregates.aggregate_group;
            break;
          }
        }
        if (aggregate_group) {
          dataValues.push({ data_target, values, aggregate_group });
        }
      } catch (error) {
        console.error('ERROR processing series:', error);
        dataValues = [];
        return;
      }
    }

    const allTimestamps = new Set<number>();
    dataValues.forEach(dv => dv.values.forEach(([ts]) => allTimestamps.add(ts)));
    const sorted = [...allTimestamps].sort((a, b) => a - b);
    this.setState({ availableTimestamps: sorted, selectedTimeIndex: -1 });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  SEARCH
  //  Stores the live point object reference (_point) instead of caching
  //  coordinates at index time — so we always get the real position.
  // ═══════════════════════════════════════════════════════════════════════════

  getAllEndpoints(): Array<{ id: string; label: string; lat: number; lng: number; _point: any }> {
    const { atlas } = this.state;
    if (!atlas) { return []; }
    const results: Array<{ id: string; label: string; lat: number; lng: number; _point: any }> = [];
    for (const t in atlas.topologies) {
      atlas.topologies[t].points.forEach((p: any) => {
        const latlng = p._latlng ?? p.marker?._latlng ?? p._marker?._latlng ?? null;
        const lat = latlng?.lat ?? p.lat ?? p.options?.lat ?? p.data?.lat ?? 0;
        const lng = latlng?.lng ?? p.lng ?? p.options?.lng ?? p.data?.lng ?? 0;
        const id  = p.id ?? p.options?.id ?? p.name ?? '';
        results.push({
          id,
          label:  p.label ?? p.options?.label ?? p.name ?? id,
          lat:    parseFloat(lat),
          lng:    parseFloat(lng),
          _point: p,
        });
      });
    }
    return results;
  }

  handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const q = e.target.value;
    if (!q.trim()) {
      this.setState({ searchQuery: q, searchResults: [], searchOpen: false });
      return;
    }
    const lower   = q.toLowerCase();
    const results = this.getAllEndpoints().filter(ep =>
      ep.label.toLowerCase().includes(lower) || ep.id.toLowerCase().includes(lower)
    );
    this.setState({ searchQuery: q, searchResults: results, searchOpen: results.length > 0 });
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  handleSearchSelect — exhaustive Leaflet map access + pan
  //
  //  Atlas4 wraps Leaflet.  The wrapper's setView may only accept one arg or
  //  an object.  We try every known way to reach the real Leaflet instance
  //  and call its two-argument setView([lat,lng], zoom).
  // ─────────────────────────────────────────────────────────────────────────
  handleSearchSelect(ep: { id: string; label: string; lat: number; lng: number; _point: any }) {
    const { atlas } = this.state;

    if (atlas) {
      const point = ep._point;

      // Re-read live position from the stored point reference
      const latlng =
        point?._latlng ??
        point?.marker?._latlng ??
        point?._marker?._latlng ??
        (typeof point?.marker?.getLatLng === 'function' ? point.marker.getLatLng() : null) ??
        (typeof point?._marker?.getLatLng === 'function' ? point._marker.getLatLng() : null) ??
        null;

      const lat = latlng?.lat ?? ep.lat;
      const lng = latlng?.lng ?? ep.lng;

      console.log('[Atlas search] panning to:', ep.id, lat, lng);

      if (lat !== 0 || lng !== 0) {
        // Try to reach the real Leaflet map through every known path
        const leafletMap: any =
          atlas.map._map          ??
          atlas.map.map           ??
          atlas.map._leaflet_map  ??
          atlas._map              ??
          atlas.leafletMap        ??
          (typeof atlas.map?.getBounds === 'function' ? atlas.map : null);

        let panned = false;

        if (leafletMap && typeof leafletMap.setView === 'function') {
          try { leafletMap.setView([lat, lng], 8, { animate: true }); panned = true; } catch (_) {}
        }

        if (!panned) {
          // Try every calling convention the Atlas wrapper might accept
          const tries = [
            () => atlas.map.setView([lat, lng], 8),
            () => atlas.map.setView({ lat, lng }, 8),
            () => atlas.map.setView({ lat, lng }),
            () => atlas.map.panTo([lat, lng]),
            () => atlas.map.panTo({ lat, lng }),
          ];
          for (const fn of tries) {
            try { fn(); panned = true; break; } catch (_) {}
          }
        }

        if (!panned) {
          console.warn('[Atlas search] could not pan — no working setView found. lat:', lat, 'lng:', lng);
        }
      }

      // Open tooltip after map animation settles
      setTimeout(() => {
        if (point) {
          try {
            if (point.tooltip) { point.tooltip.update('html'); }
            if (typeof point.showToolTip === 'function') { point.showToolTip(); }
          } catch (_) {}
          const marker = point.marker ?? point._marker;
          if (marker) {
            try { marker.openPopup(); }   catch (_) {}
            try { marker.openTooltip(); } catch (_) {}
          }
        }
      }, 600);
    }

    this.setState({
      searchQuery:         ep.label,
      searchResults:       [],
      searchOpen:          false,
      highlightedEndpoint: ep.id,
    });
    setTimeout(() => this.setState({ highlightedEndpoint: null }), 3000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TEMPORAL SCRUBBER
  // ═══════════════════════════════════════════════════════════════════════════

  handleScrubberChange(e: React.ChangeEvent<HTMLInputElement>) {
    const idx = parseInt(e.target.value, 10);
    this.setState({ selectedTimeIndex: idx }, () => { this.addDataToCircuits(); });
  }

  togglePlayback() {
    if (this.state.isPlaying) { this.stopPlayback(); } else { this.startPlayback(); }
  }

  startPlayback() {
    this.stopPlayback();
    const { availableTimestamps, selectedTimeIndex } = this.state;
    if (availableTimestamps.length === 0) { return; }
    const startIdx = selectedTimeIndex === -1 || selectedTimeIndex >= availableTimestamps.length - 1
      ? 0 : selectedTimeIndex;
    this.setState({ isPlaying: true, selectedTimeIndex: startIdx }, () => { this.addDataToCircuits(); });
    playbackTimer = setInterval(() => {
      this.setState((prev) => {
        const next = prev.selectedTimeIndex + 1;
        if (next >= prev.availableTimestamps.length) {
          this.stopPlayback();
          return { selectedTimeIndex: prev.availableTimestamps.length - 1 };
        }
        return { selectedTimeIndex: next };
      }, () => { this.addDataToCircuits(); });
    }, 400);
  }

  stopPlayback() {
    if (playbackTimer !== null) { clearInterval(playbackTimer); playbackTimer = null; }
    this.setState({ isPlaying: false });
  }

  formatTimestamp(ts: number): string {
    if (!ts) { return '--'; }
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  formatTimestampFull(ts: number): string {
    if (!ts) { return '--'; }
    return new Date(ts).toLocaleString();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EXISTING HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  getMapSelectorClass(): string[] {
    // @ts-ignore
    window.atlas = this.state.atlas;
    const classes: string[] = [];
    if (!this.props.options.mapSelector || this.props.options.mapType === 'custom') {
      classes.push(cx(styles.mapSelectorHide));
    }
    classes.push(cx(styles.mapSelectorContainer));
    if (!this.state.mapSelectorDisplay) { classes.push(cx(styles.mapSelectorCollapsed)); }
    return classes;
  }

  getAllMapLayers() {
    const { atlas } = this.state;
    if (!atlas) { return []; }
    return Object.keys(atlas.topologies).map((topologyName) => {
      const topology    = atlas.topologies[topologyName];
      const derivedName = topology.metadata?.grafana_alias || topology.name;
      return { label: derivedName, value: derivedName };
    });
  }

  getSelectedMapLayers() {
    const { mapURLs } = this.props.options;
    const selected: any[] = [];
    for (const id in mapURLs) {
      const { display, name } = mapURLs[id];
      if (display) { selected.push({ label: name, value: name }); }
    }
    return selected;
  }

  setLayerDisplay(selectedValues: SelectableValue<string>) {
    const { atlas }           = this.state;
    const { onOptionsChange } = this.props;
    const { mapURLs }         = this.props.options;
    const topologyNames       = Object.keys(atlas.topologies);
    const selectedTopologies  = selectedValues.map((val: any) => val.value);
    topologyNames.forEach((name) => atlas.hideTopology(name));
    selectedTopologies.forEach((name: string) => {
      for (const topologyName in atlas.topologies) {
        const topology = atlas.topologies[topologyName];
        if (name === topology.name || name === topology.metadata?.grafana_alias) {
          atlas.showTopology(topologyName);
        }
      }
    });
    for (const id in mapURLs) {
      mapURLs[id].display = selectedTopologies.includes(mapURLs[id].name);
    }
    onOptionsChange({ ...this.props.options });
  }

  configureAtlasEditorDisplay() {
    const { atlas, mapID } = this.state;
    const params           = urlUtil.getUrlSearchParams();
    if (params.editPanel != null && atlas) {
      atlas.map.scrollWheelZoom.enable();
      document.querySelectorAll<HTMLElement>(`#${mapID} .leaflet-control-zoom a`)
        .forEach((e) => { e.style.display = ''; });
    } else if (atlas) {
      atlas.map.scrollWheelZoom.disable();
      document.querySelectorAll<HTMLElement>(`#${mapID} .leaflet-control-zoom :not([class*=leaflet-control-zoom-])`)
        .forEach((e) => { e.style.display = 'none'; });
      atlas.editor.disableAllModes();
      if (atlas.editor.sidebar.sbContainer) { atlas.editor.hideSidebar(); }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  render() {
    const {
      searchQuery, searchResults, searchOpen,
      selectedTimeIndex, availableTimestamps, isPlaying,
      groupSelectorDisplay, groupFilter, subGroupFilter,
    } = this.state;

    const sliderMax = availableTimestamps.length > 0 ? availableTimestamps.length - 1 : 0;
    const sliderVal = selectedTimeIndex === -1 ? sliderMax : selectedTimeIndex;
    const currentTs = availableTimestamps[sliderVal] ?? null;
    const hasData   = availableTimestamps.length > 1;

    const bg       = 'var(--color-background-secondary, #1a1d23)';
    const border   = 'var(--color-border-medium, #3d3f47)';
    const textPrim = 'var(--color-text-primary, #d9d9d9)';
    const textSec  = 'var(--color-text-secondary, #8e8e99)';
    const accent   = 'var(--color-primary-text, #6e9fff)';

    return (
      <div
        id={this.state.mapWrapperID}
        style={{ position: 'relative', height: this.props.height, width: this.props.width }}
      >
        <div id={this.state.mapID} style={{ position: 'absolute', top: 0, left: 0, bottom: 0, right: 0 }} />

        {/* ── Layer selector ─────────────────────────────────────────── */}
        <div className={this.getMapSelectorClass().join(' ')} style={{ position: 'relative', zIndex: 1000 }}>
          <div
            className={cx(styles.toggleMapSelectorArea)}
            onClick={() => this.setState(s => ({ mapSelectorDisplay: !s.mapSelectorDisplay }))}
          >
            <Icon name={this.state.mapSelectorDisplay ? 'angle-right' : 'angle-left'} size="lg" />
          </div>
          <div className={cx(styles.selectorWrapper)}>
            <span className={cx(styles.layerName)}>Maps</span>
            <Select
              onChange={(e) => this.setLayerDisplay(e)}
              isMulti
              options={this.getAllMapLayers()}
              value={this.getSelectedMapLayers()}
            />
          </div>
        </div>

        {/* ══ SEARCH BAR ══════════════════════════════════════════════ */}
        <div style={{ position: 'absolute', top: '10px', right: '10px', width: '230px', zIndex: 9999 }}>
          <div style={{ position: 'relative' }}>
            <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', padding: '5px 9px' }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ marginRight: '6px', flexShrink: 0 }}>
                <circle cx="6.5" cy="6.5" r="5" stroke={textSec} strokeWidth="1.5" />
                <line x1="10.5" y1="10.5" x2="14.5" y2="14.5" stroke={textSec} strokeWidth="1.5" strokeLinecap="round" />
              </svg>
              <input
                type="text"
                placeholder="Search nodes…"
                value={searchQuery}
                onChange={this.handleSearchChange}
                onFocus={() => searchResults.length > 0 && this.setState({ searchOpen: true })}
                style={{ background: 'transparent', border: 'none', outline: 'none', color: textPrim, fontSize: '12px', width: '100%' }}
              />
              {searchQuery && (
                <button
                  onClick={() => this.setState({ searchQuery: '', searchResults: [], searchOpen: false })}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: textSec, padding: 0, marginLeft: '4px', fontSize: '16px', lineHeight: 1 }}
                >×</button>
              )}
            </div>

            {searchOpen && searchResults.length > 0 && (
              <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.5)', position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: '240px', overflowY: 'auto' }}>
                {searchResults.slice(0, 20).map(ep => (
                  <div
                    key={ep.id}
                    onClick={() => this.handleSearchSelect(ep)}
                    style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '12px', color: textPrim, borderBottom: `1px solid ${border}`, display: 'flex', alignItems: 'center', gap: '8px' }}
                    onMouseEnter={e => (e.currentTarget.style.background = 'rgba(110,159,255,0.08)')}
                    onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10">
                      <circle cx="5" cy="5" r="4" fill={accent} opacity="0.8" />
                    </svg>
                    <span style={{ fontWeight: 600 }}>{ep.label}</span>
                    {ep.id !== ep.label && (
                      <span style={{ color: textSec, fontSize: '10px', marginLeft: 'auto' }}>{ep.id}</span>
                    )}
                  </div>
                ))}
                {searchResults.length > 20 && (
                  <div style={{ padding: '4px 10px', fontSize: '11px', color: textSec }}>
                    +{searchResults.length - 20} more — refine your query
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ══ GROUP FILTER ════════════════════════════════════════════ */}
        <div style={{ position: 'absolute', top: '10px', left: '60px', display: 'flex', flexDirection: 'row', alignItems: 'flex-start', zIndex: 9999 }}>
          <div
            onClick={() => this.setState(s => ({ groupSelectorDisplay: !s.groupSelectorDisplay }))}
            style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.5)', padding: '4px 6px', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
          >
            <Icon name={groupSelectorDisplay ? 'angle-left' : 'angle-right'} size="lg" />
          </div>

          {groupSelectorDisplay && (
            <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.5)', padding: '8px', marginLeft: '4px', minWidth: '220px' }}>
              <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '6px', color: textSec, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Filter Groups
              </div>
              <Select
                onChange={(selectedValues) => {
                  const selected = (selectedValues as Array<{ label: string; value: string }>) || [];
                  this.setState({ groupFilter: selected, subGroupFilter: [] });
                  this.applyGroupFilterAdvanced(selected.map(v => v.value), []);
                }}
                isMulti
                placeholder="Select group…"
                options={this.getAllParentGroups()}
                value={groupFilter}
              />
              {this.getSubGroups(groupFilter.map(v => v.value)).length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <Select
                    onChange={(selectedValues) => {
                      const selected = (selectedValues as Array<{ label: string; value: string }>) || [];
                      this.setState({ subGroupFilter: selected });
                      this.applyGroupFilterAdvanced(groupFilter.map(v => v.value), selected.map(v => v.value));
                    }}
                    isMulti
                    placeholder="Select subgroup…"
                    options={this.getSubGroups(groupFilter.map(v => v.value))}
                    value={subGroupFilter}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ══ TEMPORAL SCRUBBER — hidden ═══════════════════════════════ */}
        {false && (
          <div style={{ position: 'absolute', bottom: '20px', left: '50%', transform: 'translateX(-50%)', minWidth: '400px', maxWidth: 'calc(100% - 60px)', zIndex: 9999 }}>
            <div style={{ background: bg, border: `1px solid ${border}`, borderRadius: '6px', boxShadow: '0 2px 12px rgba(0,0,0,0.5)', padding: '8px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <button onClick={this.togglePlayback} title={isPlaying ? 'Pause' : 'Play'} disabled={!hasData} style={{ background: isPlaying ? 'rgba(110,159,255,0.18)' : 'rgba(110,159,255,0.08)', border: `1px solid ${accent}`, borderRadius: '4px', color: accent, cursor: !hasData ? 'not-allowed' : 'pointer', opacity: !hasData ? 0.45 : 1, padding: '3px 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }}>
                    {isPlaying
                      ? <svg width="10" height="12" viewBox="0 0 10 12" fill={accent}><rect x="0" y="0" width="3.5" height="12" rx="1" /><rect x="6.5" y="0" width="3.5" height="12" rx="1" /></svg>
                      : <svg width="10" height="12" viewBox="0 0 10 12" fill={accent}><polygon points="0,0 10,6 0,12" /></svg>}
                  </button>
                  <span style={{ fontSize: '11px', color: textSec, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' }}>Time Scrubber</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '12px', color: textPrim, fontVariantNumeric: 'tabular-nums', minWidth: '160px', textAlign: 'right' }}>
                    {selectedTimeIndex === -1 ? <span style={{ color: accent }}>● Live</span> : currentTs ? this.formatTimestampFull(currentTs) : '--'}
                  </span>
                  {selectedTimeIndex !== -1 && (
                    <button onClick={() => this.setState({ selectedTimeIndex: -1 }, () => this.addDataToCircuits())} title="Return to latest" style={{ background: 'none', border: `1px solid ${border}`, borderRadius: '3px', color: textSec, cursor: 'pointer', fontSize: '10px', padding: '2px 6px', whiteSpace: 'nowrap' }}>Live ↩</button>
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '10px', color: textSec, whiteSpace: 'nowrap', flexShrink: 0, minWidth: '54px' }}>{availableTimestamps.length > 0 ? this.formatTimestamp(availableTimestamps[0]) : '--:--'}</span>
                <input type="range" min={0} max={sliderMax} value={sliderVal} onChange={this.handleScrubberChange} disabled={!hasData} style={{ flex: 1, accentColor: accent, cursor: !hasData ? 'not-allowed' : 'pointer', opacity: !hasData ? 0.45 : 1, height: '4px' }} />
                <span style={{ fontSize: '10px', color: textSec, whiteSpace: 'nowrap', flexShrink: 0, minWidth: '54px', textAlign: 'right' }}>{availableTimestamps.length > 0 ? this.formatTimestamp(availableTimestamps[availableTimestamps.length - 1]) : '--:--'}</span>
              </div>
              <div style={{ marginTop: '4px', textAlign: 'center' }}>
                <span style={{ fontSize: '10px', color: textSec }}>
                  {availableTimestamps.length === 0 ? 'No data loaded' : selectedTimeIndex === -1 ? `${availableTimestamps.length} data point${availableTimestamps.length !== 1 ? 's' : ''} — live view` : `Step ${sliderVal + 1} / ${availableTimestamps.length}`}
                </span>
              </div>
            </div>
          </div>
        )}

      </div>
    );
  }
}