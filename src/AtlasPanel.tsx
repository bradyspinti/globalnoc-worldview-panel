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
// @ts-ignore
let styles = getMapSelectorTheme(config.theme);

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
    };
    this.setLayerDisplay = this.setLayerDisplay.bind(this);
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

  shouldComponentUpdate(nextProps: any, nextState: any) {
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
    atlas.map.on('moveend dragend', (e: any) => {
      if (!e.originalEvent) { return; } // ignore moves we triggered ourselves via setView()
      const center  = atlas.map.getCenter();
      const mapView = { ...this.props.options.mapView };
      mapView.lat   = center.lat.toFixed(4);
      mapView.lng   = center.lng.toFixed(4);
      mapView.zoom  = atlas.map.getZoom();
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
          for (const map of atlasObj) {
            map.metadata.mb_url        = url;
            map.metadata.grafana_alias = name;
            atlas.addTopology(map);
            setData();
            if (!display) { atlas.hideTopology(map.name); }
            reinforceView(lat, lng);
          }
        } else {
          console.log('Bailing This Request');
        }
      } catch (error) {
        console.error('Error loading map from URL:', url, error);
      }
    }
  }

  reinforceView(lat: any, lng: any) {
    this.state.atlas.map.setView({ lat, lng });
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
      try { setData(); } catch (error) { console.log('Could not set data :('); }
      reinforceView(lat, lng);
    }
  }

  setMapView() {
    const { atlas }          = this.state;
    const { lat, lng, zoom } = this.props.options.mapView;
    atlas.map.setView({ lat, lng }, zoom);
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
            const childMatch  = selectedSubs.length === 0   || selectedSubs.includes(child);
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATA
  // ═══════════════════════════════════════════════════════════════════════════

  setTopologyData() {
    const { data } = this.props;
    if (data.state === 'Done' && lastDataDictionaryCreated !== data.request!.requestId) {
      this.createDataDictionary();
    }
    this.addDataToCircuits();
  }

  private reduceValues(vals: number[], mode: string): number {
    if (vals.length === 0) { return 0; }
    switch (mode) {
      case 'chooseMax': return Math.max(...vals);
      case 'chooseMin': return Math.min(...vals);
      case 'chooseAvg': return vals.reduce((a, b) => a + b, 0) / vals.length;
      case 'chooseSum': return vals.reduce((a, b) => a + b, 0);
      default:          return vals[vals.length - 1] ?? 0;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  //  buildTooltipHtml
  //
  //  Generates the tooltip HTML dynamically based on whichever aggregate
  //  groups are actually present on this line, using their real names as
  //  row labels. This means:
  //    - Changing "Input"→"Download" in Data Aggregates updates the popup
  //    - A line with 3 groups gets 3 rows automatically
  //    - No more hardcoded "Input" / "Output" strings
  //
  //  The template from options.topology.line.tooltip.content is used for
  //  the popup header/wrapper. The data rows are injected into a placeholder
  //  {{DATA_ROWS}} in that template. If your template doesn't have that
  //  placeholder, rows are appended before the closing tag.
  //
  //  groupValues: Map<aggregateGroupName, formattedValueString>
  //  lineName: the line's display name for the title row
  // ─────────────────────────────────────────────────────────────────────────




  // private buildTooltipHtml(
  //   template: string,
  //   groupValues: Map<string, string>,
  //   lineName: string,
  // ): string {
  //   // Build one table row per group, capitalising the group name as the label
  //   const rows = [...groupValues.entries()]
  //     .map(([grp, val]) => {
  //       const label = grp.charAt(0).toUpperCase() + grp.slice(1);
  //       return `<tr>
  //         <td style="padding:2px 12px 2px 0;font-weight:600;white-space:nowrap">${label}</td>
  //         <td style="padding:2px 0;text-align:right;white-space:nowrap">${val}</td>
  //       </tr>`;
  //     })
  //     .join('');

  //   const dataBlock = `<table style="width:100%;border-collapse:collapse">${rows}</table>`;

  //   // If the template has our placeholder, replace it
  //   if (template.includes('{{DATA_ROWS}}')) {
  //     return template.replace('{{DATA_ROWS}}', dataBlock);
  //   }

  //   // Otherwise replace the legacy fixed placeholders if they exist, AND
  //   // also append any extra groups that don't have a matching placeholder.
  //   // This keeps backwards compat with old templates that use
  //   // $dataValues.input.now / $dataValues.output.now.
  //   let html = template;
  //   const replaced = new Set<string>();

  //   groupValues.forEach((val, grp) => {
  //     // Try the exact group name first (e.g. $dataValues.upload.now)
  //     const exact = new RegExp(`\\$dataValues\\.${grp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.now`, 'gi');
  //     if (exact.test(html)) {
  //       html = html.replace(exact, val);
  //       replaced.add(grp);
  //       return;
  //     }
  //     // Legacy aliases: a group whose name contains "in" (but not "out") → input
  //     // a group whose name contains "out" → output
  //     const lower = grp.toLowerCase();
  //     const isIn  = lower.includes('in') && !lower.includes('out');
  //     const isOut = lower.includes('out');
  //     if (isIn && /\$dataValues\.input\.now/i.test(html)) {
  //       html = html.replace(/\$dataValues\.input\.now/gi, val);
  //       replaced.add(grp);
  //     } else if (isOut && /\$dataValues\.output\.now/i.test(html)) {
  //       html = html.replace(/\$dataValues\.output\.now/gi, val);
  //       replaced.add(grp);
  //     }
  //   });

  //   // For any groups that had no placeholder at all, inject them before </div>
  //   const extras = [...groupValues.entries()].filter(([grp]) => !replaced.has(grp));
  //   if (extras.length > 0) {
  //     const extraRows = extras
  //       .map(([grp, val]) => {
  //         const label = grp.charAt(0).toUpperCase() + grp.slice(1);
  //         return `<tr>
  //           <td style="padding:2px 12px 2px 0;font-weight:600;white-space:nowrap">${label}</td>
  //           <td style="padding:2px 0;text-align:right;white-space:nowrap">${val}</td>
  //         </tr>`;
  //       })
  //       .join('');
  //     const extraBlock = `<table style="width:100%;border-collapse:collapse;margin-top:4px">${extraRows}</table>`;
  //     // Insert before the last closing tag
  //     const lastClose = html.lastIndexOf('</');
  //     if (lastClose !== -1) {
  //       html = html.slice(0, lastClose) + extraBlock + html.slice(lastClose);
  //     } else {
  //       html += extraBlock;
  //     }
  //   }

  //   return html;
  // }

private buildTooltipHtml(
    template: string,
    groupValues: Map<string, string>,
    lineName: string,
  ): string {
    // added 12px padding on the left and right so it doesnt hug the walls
    const rows = [...groupValues.entries()]
      .map(([grp, val]) => {
        const label = grp.charAt(0).toUpperCase() + grp.slice(1);
        return `<tr>
          <td style="padding:2px 12px 2px 12px;font-weight:600;white-space:nowrap;font-size:14px;">${label}</td>
          <td style="padding:2px 12px 2px 0;text-align:right;white-space:nowrap;font-size:14px;">${val}</td>
        </tr>`;
      })
      .join('');

    const dataBlock = `<table style="width:100%;border-collapse:collapse;margin-top:4px">${rows}</table>`;

    if (template.includes('{{DATA_ROWS}}')) {
      return template.replace('{{DATA_ROWS}}', dataBlock);
    }

    let html = template;

    html = html.replace(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*?\$dataValues\.(?:(?!<\/tr>)[\s\S])*?<\/tr>/gi, '');
    html = html.replace(/<div[^>]*>(?:(?!<\/?div)[\s\S])*?\$dataValues\.(?:(?!<\/?div)[\s\S])*?<\/div>/gi, '');
    html = html.replace(/<li[^>]*>(?:(?!<\/li>)[\s\S])*?\$dataValues\.(?:(?!<\/li>)[\s\S])*?<\/li>/gi, '');

    const lastClose = html.lastIndexOf('</div>');
    if (lastClose !== -1) {
      html = html.slice(0, lastClose) + dataBlock + html.slice(lastClose);
    } else {
      html += dataBlock;
    }

    return html;
  }

  addDataToCircuits() {
    console.error("test2")
    const { atlas }   = this.state;
    const { options } = this.props;

    if (!atlas) { return; }

    atlas.applyData(dataValues);
    this.setDataMappingOptions();

    const legendMin = atlas.legends?.lines?.min;
    const legendMax = atlas.legends?.lines?.max;

    // ── Coloring pass (unchanged from working version) ─────────────────────
    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((line: any) => {
        line.min = legendMin;
        line.max = legendMax;

        const lineDataTargets: string[] = line.metadata?.data_targets;
        const hasCurrentData =
          Array.isArray(lineDataTargets) &&
          lineDataTargets.length > 0 &&
          lineDataTargets.some((target: string) =>
            dataValues.some((dv) => dv.data_target === target)
          );

        if (!hasCurrentData) {
          try { line.hide(); } catch (_) {}
          return;
        } else {
          try { line.show(); } catch (_) {}
        }

        const dataTarget  = line.dataTarget;
        const criteria    = line.colorCriteria || 'now';
        const dv          = line.data?.dataValues;

        if (dv) {
          const vals: number[] = Object.keys(dv)
            .map((k: string) => dv[k][criteria])
            .filter((v: any) => v != null && !isNaN(v));

          if (vals.length > 0) {
            let colorNumber: number | undefined;
            if      (dataTarget === 'chooseMax') { colorNumber = Math.max(...vals); }
            else if (dataTarget === 'chooseMin') { colorNumber = Math.min(...vals); }
            else if (dataTarget === 'chooseAvg') { colorNumber = vals.reduce((a: number, b: number) => a + b, 0) / vals.length; }
            else if (dataTarget === 'chooseSum') { colorNumber = vals.reduce((a: number, b: number) => a + b, 0); }
            else if (dv[dataTarget] != null)     { colorNumber = dv[dataTarget][criteria]; }

            if ((dataTarget === 'chooseAvg' || dataTarget === 'chooseSum') && colorNumber !== undefined) {
              const color = line.legend?.color(colorNumber, legendMin, legendMax);
              if (color) { line.color = color; }
            }
          }
        }

        try { line.update('data'); } catch (_) {}
      });
    }

    // ── Tooltip pass ───────────────────────────────────────────────────────
    if (!dataValues || dataValues.length === 0) { return; }

    const selection = options.dataMappings.dataTarget;
    const units     = atlas.legends?.lines?.units || '';

    const fmt = (v: number): string => {
      if (v >= 1000 && (units.toLowerCase().includes('bps') || units.toLowerCase().includes('bit'))) {
        if (v >= 1_000_000_000) { return `${(v / 1_000_000_000).toFixed(2)} Gbps`; }
        if (v >= 1_000_000)     { return `${(v / 1_000_000).toFixed(2)} Mbps`; }
        if (v >= 1_000)         { return `${(v / 1_000).toFixed(2)} Kbps`; }
      }
      return (v < 1000 || !units.toLowerCase().includes('bps'))
        ? v.toFixed(0)
        : `${v.toFixed(2)} ${units}`;
    };

    try {
      for (const t in atlas.topologies) {
        atlas.topologies[t].lines.forEach((line: any) => {
          try {
            const dataTargets: string[] = line.metadata?.data_targets;
            if (!dataTargets || !Array.isArray(dataTargets) || dataTargets.length === 0) { return; }

            // ── Collect latest value per aggregate group ──────────────────
            // One bucket per unique aggregate_group name. Each data_target
            // goes into exactly one bucket — its own group. No double-counting.
            const groupBuckets = new Map<string, number[]>();

            dataTargets.forEach((targetName: string) => {
              const dv = dataValues.find(d => d.data_target === targetName);
              if (!dv || !dv.values.length) { return; }
              const latest = dv.values[dv.values.length - 1]?.[1];
              if (latest === null || latest === undefined) { return; }

              const grp = dv.aggregate_group || 'data';
              if (!groupBuckets.has(grp)) { groupBuckets.set(grp, []); }
              groupBuckets.get(grp)!.push(latest);
            });

            if (groupBuckets.size === 0) { return; }

            // ── Reduce each group's values using the selected aggregation ──
            const groupValues = new Map<string, string>();
            groupBuckets.forEach((vals, grp) => {
              groupValues.set(grp, fmt(this.reduceValues(vals, selection)));
            });

            // ── Inject into tooltip HTML ───────────────────────────────────
            if (line.tooltip && options.topology.line.tooltip.content) {
              const lineName = line.metadata?.name || line.name || '';
              line.tooltip.html = this.buildTooltipHtml(
                options.topology.line.tooltip.content,
                groupValues,
                lineName,
              );
              line.tooltip.update('html');
            }
          } catch (_) {}
        });
      }
    } catch (_) {}
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

        const rawTime   = typeof seriesItem.fields[0].values?.toArray === 'function'
          ? seriesItem.fields[0].values.toArray()
          : (Array.isArray(seriesItem.fields[0].values) ? seriesItem.fields[0].values : []);
        const rawValues = typeof seriesItem.fields[1].values?.toArray === 'function'
          ? seriesItem.fields[1].values.toArray()
          : (Array.isArray(seriesItem.fields[1].values) ? seriesItem.fields[1].values : []);

        const timestamps = [...rawTime]   as number[];
        const speeds     = [...rawValues] as number[];

        // Sort ascending so last entry = latest value
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
        dataValues = [];
        return;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  MAP LAYER SELECTOR
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  EDITOR DISPLAY
  // ═══════════════════════════════════════════════════════════════════════════

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
    const { groupSelectorDisplay, groupFilter, subGroupFilter } = this.state;

    const bg      = 'var(--color-background-secondary, #1a1d23)';
    const border  = 'var(--color-border-medium, #3d3f47)';
    const textSec = 'var(--color-text-secondary, #8e8e99)';

    return (
      <div
        id={this.state.mapWrapperID}
        style={{
          position: 'relative',
          zIndex: 9,
          height: this.props.height,
          width: this.props.width,
        }}
      >
        {/* ── Map canvas ─────────────────────────────────────────────── */}
        <div id={this.state.mapID} style={{ height: '100%' }} />

        {/* ── Layer selector ─────────────────────────────────────────── */}
        <div className={this.getMapSelectorClass().join(' ')}>
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
              isMulti={true}
              options={this.getAllMapLayers()}
              value={this.getSelectedMapLayers()}
            />
          </div>
        </div>

        {/* ── Group filter ───────────────────────────────────────────── */}
        <div style={{
          position: 'absolute', top: '10px', left: '60px',
          display: 'flex', flexDirection: 'row', alignItems: 'flex-start',
          zIndex: 9999,
        }}>
          <div
            onClick={() => this.setState(s => ({ groupSelectorDisplay: !s.groupSelectorDisplay }))}
            style={{
              background: bg, border: `1px solid ${border}`, borderRadius: '6px',
              boxShadow: '0 2px 12px rgba(0,0,0,0.5)', padding: '4px 6px',
              cursor: 'pointer', display: 'flex', alignItems: 'center',
            }}
          >
            <Icon name={groupSelectorDisplay ? 'angle-left' : 'angle-right'} size="lg" />
          </div>

          {groupSelectorDisplay && (
            <div style={{
              background: bg, border: `1px solid ${border}`, borderRadius: '6px',
              boxShadow: '0 2px 12px rgba(0,0,0,0.5)', padding: '8px',
              marginLeft: '4px', minWidth: '220px',
            }}>
              <div style={{
                fontSize: '11px', fontWeight: 600, marginBottom: '6px',
                color: textSec, textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>
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
                      this.applyGroupFilterAdvanced(
                        groupFilter.map(v => v.value),
                        selected.map(v => v.value),
                      );
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

      </div>
    );
  }
}