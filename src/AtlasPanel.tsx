import React, { Component } from 'react';
import { PanelProps, SelectableValue, urlUtil } from '@grafana/data';
import { SimpleOptions } from 'types';
import { v4 as uuidv4 } from 'uuid';
// import { DataUtil } from './util/DataUtil';
import { Select, Icon } from '@grafana/ui';
import { cx } from 'emotion';
import { getMapSelectorTheme } from './util/MapSelector';
import AtlasOptions from './config/AtlasOptions.js';
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

let editFromPanel = false;
let fetchSession: FetchSession = {};
let mapUpdated = false;
let lastDataDictionaryCreated = '';
let dataValues: DataValue[] = [];
// Map of endpoint ID → group(s), built from raw JSON before Atlas processes it
let endpointGroupMap: { [id: string]: string[] } = {};
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

  componentDidMount() {
    let atlas = new Atlas(this.state.mapID, AtlasOptions);
    this.setState({ atlas }, () => {
      this.atlasInitialized();
      this.configureAtlasEditorDisplay();
    });
  }

  shouldComponentUpdate(nextProps, nextState) {
    // Only re fetch maps if map settings arfe edited
    if (
      nextProps.options.mapType !== this.props.options.mapType ||
      JSON.stringify(nextProps.options.mapURLs) !== JSON.stringify(this.props.options.mapURLs)
    ) {
      mapUpdated = true;
    }

    return true;
  }

  componentDidUpdate() {
    // Refresh Leaflet Container whenever component is rerendered
    // Rerender will happen whenever the hieght/width of container is resized
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

  setListeners() {
    this.setUpdateListeners();
    this.setMapViewUpdateListeners();
    this.setTopologyUpdateListeners();
  }

  setMapViewUpdateListeners() {
    let { atlas } = this.state;
    atlas.map.on('moveend dragend', () => {
      let center = atlas.map.getCenter();

      let mapView = { ...this.props.options.mapView };
      mapView.lat = center.lat.toFixed(4);
      mapView.lng = center.lng.toFixed(4);
      mapView.zoom = atlas.map.getZoom();
      editFromPanel = true;
      this.props.onOptionsChange({
        ...this.props.options,
        mapView,
      });
    });
  }

  setUpdateListeners() {
    let { atlas } = this.state;
    atlas.on('update', () => {
      let { mapType } = this.props.options;
      let json = atlas.getJSON();
      let options = this.props.options;
      options.customMapJSON = { content: JSON.stringify(json[0], null, 2), mode: 'json' };
      editFromPanel = true;
      if (mapType === 'custom') {
        this.props.onOptionsChange({ ...options });
      }
    });
  }

  setMapFromOptions() {
    let { mapType } = this.props.options;
    if (mapType === 'custom') {
      this.setCustomMap();
    } else {
      this.setURLMap();
    }
  }

  setURLMap() {
    let { atlas } = this.state;
    let { mapURLs } = this.props.options;
    let { lat, lng } = this.props.options.mapView;
    let reinforceView = this.reinforceView.bind(this);
    let setData = this.setTopologyData.bind(this);
    atlas.editor.disableAllModes();

    let editorButton = document.querySelector('.atlas-toggle-editor') as HTMLAnchorElement;
    editorButton.style.display = 'none';
    if (atlas.editor.sidebar.sbContainer) {
      atlas.editor.hideToolbar();
      atlas.editor.hideSidebar();
    }

    atlas.removeAllTopologies();

    let buildGroupMap = this.buildEndpointGroupMap.bind(this);

    for (const id in mapURLs) {
      let sessionID = uuidv4();
      fetchSession[mapURLs[id].url] = sessionID;
      fetchMaps(mapURLs[id], sessionID);
    }

async function fetchMaps(mapURL, sessionID) {
  let { url, name, display } = mapURL;
  if (url === '') {
    return;
  }
  try {
    const request = await fetch(url);
    const atlasObj = await request.json();
    if (sessionID === fetchSession[url]) {
      // Build endpoint→group map from raw fetched JSON before Atlas processes it
      buildGroupMap(atlasObj);
      for (const map of atlasObj) {
        map.metadata.mb_url = url;
        map.metadata.grafana_alias = name;
        
        atlas.addTopology(map);
        
        // Wait for topology to be ready before applying data
        setTimeout(() => {
          setData();
        }, 100);
        
        if (!display) {
          atlas.hideTopology(map.name);
        }
        reinforceView(lat, lng);
      }
    } else {
      console.error('Bailing This Request');
    }
  } catch (error) {
    console.error("Error loading map from URL:", url, error);
  }
}
  }

  // Leaflet Bug
  reinforceView(lat, lng) {
    let { atlas } = this.state;
    atlas.map.setView({ lat, lng });
  }

  setCustomMap() {
  let { atlas } = this.state;
  let { customMapJSON } = this.props.options;
  let topology;
  let reinforceView = this.reinforceView.bind(this);
  let setData = this.setTopologyData.bind(this);
  let { lat, lng } = this.props.options.mapView;
  
  try {
    topology = JSON.parse(customMapJSON.content);
  } catch (e) {
    console.error('Unable to parse JSON data from Panel Options Editor');
  }

  let editorButton = document.querySelector('.atlas-toggle-editor') as HTMLAnchorElement;
  editorButton.style.display = '';
  
  if (topology) {
    // Build our endpoint→group map from raw JSON before Atlas drops unknown fields
    this.buildEndpointGroupMap(topology);

    // Disable Atlas Editor
    atlas.editor.disableAllModes();
    if (atlas.editor.sidebar.sbContainer) {
      atlas.editor.hideToolbar();
      atlas.editor.hideSidebar();
    }

    // Remove all existing topologies and add new one
    atlas.removeAllTopologies();
    console.error(topology);
    
    if (Array.isArray(topology)) {
      for (const topo of topology) {
        atlas.addTopology(topo);
      }
    } else {
      atlas.addTopology(topology);
    }

    // IMPORTANT: Wait a tick for topology to be fully added before applying data
    setTimeout(() => {
      try {
        setData();
      } catch (error) {
        console.error('Could not set data :(', error);
      }
    }, 100);

    reinforceView(lat, lng);
  }
}

  setMapView() {
    let { atlas } = this.state;
    let { lat, lng, zoom } = this.props.options.mapView;

    atlas.map.setZoom(zoom);

    const setViewAfterZoom = () => {
      atlas.map.setView({ lat, lng });
    };

    atlas.map.on('zoomend', setViewAfterZoom);

    const moveEndListener = () => {
      atlas.map.off('zoomend', setViewAfterZoom);
      atlas.map.off('moveend', moveEndListener);
    };

    atlas.map.on('moveend', moveEndListener);
  }

  setMapTile() {
    let { atlas } = this.state;
    let { mapTile, mapTileURL } = this.props.options;

    if (!mapTileURL) {
      mapTileURL = '';
    }

    if (mapTile) {
      atlas.addTile({
        url: mapTileURL,
        maxZoom: 20,
        name: 'custom',
      });
    }

    mapTile ? atlas.showTile('custom') : atlas.showTile('map');
  }

  setWeatherTile() {
    let { atlas } = this.state;
    let { weatherTile } = this.props.options;
    if (weatherTile) {
      atlas.showOverlayTile('weather');
      atlas.redrawOverlayTiles();
    } else {
      atlas.hideOverlayTile('weather');
    }
  }

  getAllParentGroups() {
  const { atlas } = this.state;
  const parents = new Set<string>();
  if (!atlas) return [];

  for (const t in atlas.topologies) {
    atlas.topologies[t].lines.forEach((l: any) => {
      const g = l.metadata?.group;
      const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);

      groups.forEach((grp) => {
        const parent = grp.includes(':') ? grp.split(':')[0] : grp;
        parents.add(parent);
      });
    });
  }

  return [...parents].map(g => ({ label: g, value: g }));
}

applyGroupFilterAdvanced(selectedParents: string[], selectedSubs: string[]) {
  const { atlas } = this.state;
  if (!atlas) return;

  for (const t in atlas.topologies) {
    const topology = atlas.topologies[t];

    topology.lines.forEach((l: any) => {
      const g = l.metadata?.group;
      const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);

      const visible =
        groups.length === 0 ||
        groups.some((grp) => {
          // FLAT GROUP SUPPORT (old behavior)
          if (!grp.includes(':')) {
            return selectedParents.length === 0 || selectedParents.includes(grp);
          }

          // NEW hierarchical logic
          const [parent, child] = grp.split(':');

          const parentMatch =
            selectedParents.length === 0 || selectedParents.includes(parent);

          const childMatch =
            selectedSubs.length === 0 || selectedSubs.includes(child);

          return parentMatch && childMatch;
        });

      try {
        visible ? l.show() : l.hide();
      } catch (_) {}
    });
  }
}

getSubGroups(selectedParents: string[]) {
  const { atlas } = this.state;
  const subs = new Set<string>();
  if (!atlas) return [];

  for (const t in atlas.topologies) {
    atlas.topologies[t].lines.forEach((l: any) => {
      const g = l.metadata?.group;
      const groups: string[] = Array.isArray(g) ? g : (g ? [g] : []);

      groups.forEach((grp) => {
        if (!grp.includes(':')) return; // ignore flat groups

        const [parent, child] = grp.split(':');

        if (
          selectedParents.length === 0 ||
          selectedParents.includes(parent)
        ) {
          if (child) subs.add(child);
        }
      });
    });
  }

  return [...subs].map(g => ({ label: g, value: g }));
}

  setLegendConfiguration() {
    let { atlas } = this.state;
    let { legend } = this.props.options;

    atlas.changeLegendProperty('lines', 'type', legend.type);
    atlas.changeLegendProperty('lines', 'units', legend.unit);
    atlas.changeLegendValues('lines', legend.threshold, legend.colors);

    if (legend.display) {
      atlas.legends.lines.show();
      atlas.changeLegendProperty('lines', 'orientation', legend.orientation);
      atlas.changeLegendProperty('lines', 'size', legend.size + '%');

      let labelBar = atlas.legends.lines.labelBar as HTMLDivElement;
      let labels = Array.from(labelBar.children) as HTMLDivElement[];
      for (const label of labels) {
        label.style.color = legend.textColor;
      }
    } else {
      atlas.legends.lines.hide();
    }
  }

  setDataMappingOptions() {
    let { dataMappings } = this.props.options;
    let { atlas } = this.state;
    console.error('DATA MAPPING', dataMappings);
    for (const property in dataMappings) {
      atlas.changeCircuitColoringProperties(property, dataMappings[property]);
    }
  }

  setTopologyUpdateListeners() {
    let { atlas } = this.state;

    atlas.on('topology-added', () => {
      this.setTopologyHelper();
    });
  }

  setTopologyOptions() {
    this.setTopologyHelper();
  }

  setTopologyHelper() {
    let { atlas } = this.state;
    let topologyOptions = this.props.options.topology;

    for (const t in atlas.topologies) {
      let topology = atlas.topologies[t];

      topology.points.forEach((p) => {
        p.color = topologyOptions.point.color;
        p.fill = topologyOptions.point.color;

        let display = topologyOptions.point.tooltip.display;
        let staticTooltip = topologyOptions.point.tooltip.static;

        if (display) {
          p.tooltip.html = topologyOptions.point.tooltip.content;
          p.tooltip.update('html');
        }

        if (display && staticTooltip) {
          p.makeStatic(true);
        } else {
          p.makeStatic(false);
        }

        if (display) {
          p.showToolTip();
        } else {
          p.hideToolTip();
        }

        p.update();
      });

      topology.lines.forEach((l) => {
        l.options.color = topologyOptions.line.color;
        let display = topologyOptions.line.tooltip.display;

        if (display) {
          l.tooltip.html = topologyOptions.line.tooltip.content;
          l.tooltip.update('data');
        }

        if (display) {
          l.showToolTip();
        } else {
          l.hideToolTip();
        }

        try {
          l.update('style');
        } catch (error) {}
      });
    }
  }

  // Build a map of endpoint ID → group(s) from the raw topology JSON.
  // Called before Atlas processes the topology so we capture fields Atlas may drop.
  buildEndpointGroupMap(topologyObj: any) {
    const topo = Array.isArray(topologyObj) ? topologyObj : [topologyObj];
    topo.forEach((t: any) => {
      const endpoints = t.endpoints || {};
      Object.keys(endpoints).forEach(id => {
        const ep = endpoints[id];
        const g = ep.group ?? ep.metadata?.group;
        if (g) {
          endpointGroupMap[id] = Array.isArray(g) ? g : [g];
        }
      });
    });
  }

  computeFromGroup(nums: number[], group: string): number {
    if (nums.length === 0) return 0;
    const g = group.toLowerCase();
    if (g.includes('sum'))                          return nums.reduce((a, b) => a + b, 0);
    if (g.includes('avg') || g.includes('average')) return nums.reduce((a, b) => a + b, 0) / nums.length;
    if (g.includes('min'))                          return Math.min(...nums);
    if (g.includes('max'))                          return Math.max(...nums);
    return nums[nums.length - 1];
  }

  isInputGroup(group: string): boolean {
    const g = group.toLowerCase().trim();
    return g === 'input' || g === 'in' || g.startsWith('input_') || g.startsWith('in_') || g.endsWith('_input') || g.endsWith('_in');
  }

  isOutputGroup(group: string): boolean {
    const g = group.toLowerCase().trim();
    return g === 'output' || g === 'out' || g.startsWith('output_') || g.startsWith('out_') || g.endsWith('_output') || g.endsWith('_out');
  }

  addDataToCircuits() {
    const { atlas } = this.state;
    const { options } = this.props;
    if (!atlas || !dataValues || dataValues.length === 0) return;

    atlas.applyData(dataValues);

    const selection = options.dataMappings.dataTarget;

    try {
      for (const t in atlas.topologies) {
        const topology = atlas.topologies[t];

        topology.lines.forEach((line: any) => {
          try {
            const dataTargets = line.metadata?.data_targets;
            if (!dataTargets || !Array.isArray(dataTargets) || dataTargets.length === 0) return;

            let inputVals: number[] = [];
            let outputVals: number[] = [];

            // Collect all matching data targets
            dataTargets.forEach((targetName: string) => {
              const matchingData = dataValues.find((dv: any) => dv.data_target === targetName);
              if (matchingData && matchingData.values && matchingData.values.length > 0) {
                const latestValue = matchingData.values[matchingData.values.length - 1];
                if (latestValue && latestValue[1] !== undefined) {
                  const value = latestValue[1];
                  const group = matchingData.aggregate_group?.toLowerCase() || '';
                  if (group.includes('input') || group.includes('in')) {
                    inputVals.push(value);
                  } else if (group.includes('output') || group.includes('out')) {
                    outputVals.push(value);
                  }
                }
              }
            });

            // Calculation helper
            const calculate = (vals: number[]) => {
              if (vals.length === 0) return 0;
              switch (selection) {
                case 'chooseSum': return vals.reduce((a, b) => a + b, 0);
                case 'chooseAvg': return vals.reduce((a, b) => a + b, 0) / vals.length;
                case 'chooseMin': return Math.min(...vals);
                case 'chooseMax': return Math.max(...vals);
                default: return vals[0] || 0;
              }
            };

            const finalIn  = calculate(inputVals);
            const finalOut = calculate(outputVals);

            line.appliedData = {
              now: finalIn,
              aggregate_group: 'input',
            };

            line.dataValues = {
              input:  { now: finalIn  },
              output: { now: finalOut },
            };

            const units = atlas.legends?.lines?.units || '';
            const formatValue = (value: number | null) => {
              if (value === null || value === undefined) return '0';
              if (value >= 1000 && (units.toLowerCase().includes('bps') || units.toLowerCase().includes('bit'))) {
                if (value >= 1000000000) return `${(value / 1000000000).toFixed(2)} Gbps`;
                if (value >= 1000000)    return `${(value / 1000000).toFixed(2)} Mbps`;
                if (value >= 1000)       return `${(value / 1000).toFixed(2)} Kbps`;
              }
              return (value < 1000 || !units.toLowerCase().includes('bps'))
                ? value.toFixed(0)
                : `${value.toFixed(2)} ${units}`;
            };

            if (line.tooltip && options.topology.line.tooltip.content) {
              line.tooltip.html = options.topology.line.tooltip.content
                .replace(/\$dataValues\.input\.now/g,  formatValue(finalIn))
                .replace(/\$dataValues\.output\.now/g, formatValue(finalOut));
              line.tooltip.update('html');
            }

            if (line.update && (line._path || typeof line._updateBounds === 'function')) {
              try { line.update('style'); } catch (_) {}
            }

          } catch (err) {
            console.error('Error processing line:', err);
          }
        });
      }
    } catch (err) {
      console.error('Error in data application:', err);
    }

    this.setDataMappingOptions();
  }

  // Helper to keep the code clean
  updateLineTooltip(line: any, inv: number | null, outv: number | null) {
    const { atlas } = this.state;
    const { topology } = this.props.options;
    const units = atlas.legends?.lines?.units || '';

    const format = (v: number | null) => {
      if (v === null) return 'N/A';
      if (v >= 1000000000) return `${(v / 1000000000).toFixed(2)} G`;
      if (v >= 1000000)    return `${(v / 1000000).toFixed(2)} M`;
      return `${v.toFixed(2)} ${units}`;
    };

    if (line.tooltip) {
      let content = topology.line.tooltip.content;
      line.tooltip.html = content
        .replace(/\$dataValues\.input\.now/g,  format(inv))
        .replace(/\$dataValues\.output\.now/g, format(outv));
      line.tooltip.update('html');
    }
  }

  setTopologyData() {
    let { data } = this.props;

    // Only create a new data dictionary if data is fetched again
    if (data.state === 'Done' && lastDataDictionaryCreated !== data.request!.requestId) {
      this.createDataDictionary();
    }
    this.addDataToCircuits();
  }

  createDataDictionary() {
    let { series, request } = this.props.data;
    
    lastDataDictionaryCreated = request!.requestId;
    dataValues = [];

    let data_aggregates = this.props.options.dataAggregateGroups;

    if (data_aggregates.length === 0) {
      data_aggregates.push({
        aggregate_group: 'data',
        pattern: '.*',
      });
    }

    for (const data of series) {
      try {
        let data_target: string = data.name!;
        
        let speeds     = data.fields[1].values.toArray().reverse() as number[];
        let timestamps = data.fields[0].values.toArray().reverse() as number[];

        let values: Array<[number, number]> = [];

        for (let i = 0; i < speeds.length; i++) {
          values.push([timestamps[i], speeds[i]]);
        }

        let aggregate_group: string | undefined;

        for (const aggregates of data_aggregates) {
          if (!aggregates.pattern) {
            continue;
          }
          let regex = new RegExp(aggregates.pattern);
          if (regex.test(data_target)) {
            aggregate_group = aggregates.aggregate_group;
            break;
          }
        }

        if (aggregate_group) {
          dataValues.push({
            data_target,
            values,
            aggregate_group,
          });
        }
      } catch (error) {
        console.error('ERROR processing series:', error);
        dataValues = [];
        return;
      }
    }

    // ============================================================
    // DEBUG BLOCK E — log what createDataDictionary produced
    // ============================================================
    console.error('%c[Atlas] createDataDictionary result', 'color:magenta;font-weight:bold');
    dataValues.forEach(dv => {
      console.error(`  target="${dv.data_target}"  group="${dv.aggregate_group}"  points=${dv.values.length}`);
    });
    //console.groupEnd();
  }

  getMapSelectorClass(): string[] {
    // @ts-ignore
    window.atlas = this.state.atlas;
    let classes: string[] = [];

    if (!this.props.options.mapSelector || this.props.options.mapType === 'custom') {
      classes.push(cx(styles.mapSelectorHide));
    }

    classes.push(cx(styles.mapSelectorContainer));

    if (!this.state.mapSelectorDisplay) {
      classes.push(cx(styles.mapSelectorCollapsed));
    }

    return classes;
  }

  getAllMapLayers() {
    let { atlas } = this.state;
    if (atlas) {
      let topologies = Object.keys(atlas.topologies);

      let options = topologies.map((topologyName) => {
        let topology = atlas.topologies[topologyName];
        let derivedName = topology.metadata?.grafana_alias || topology.name;
        return { label: derivedName, value: derivedName };
      });

      return options;
    }
    return [];
  }

  getSelectedMapLayers() {
    let { mapURLs } = this.props.options;
    let selectedlayers: any[] = [];
    for (const id in mapURLs) {
      let { display, name } = mapURLs[id];
      if (display) {
        selectedlayers.push({ label: name, value: name });
      }
    }
    return selectedlayers;
  }

  setLayerDisplay(selectedValues: SelectableValue<string>) {
    let { atlas } = this.state;
    let { onOptionsChange } = this.props;
    let { mapURLs } = this.props.options;

    let topologyNames = Object.keys(atlas.topologies);
    let selectedTopologies = selectedValues.map((val) => val.value);

    topologyNames.forEach((name) => atlas.hideTopology(name));

    selectedTopologies.forEach((name) => {
      let topologies = atlas.topologies;

      for (const topologyName in topologies) {
        let topology = topologies[topologyName];
        if (name === topology.name || name === topology.metadata?.grafana_alias) {
          atlas.showTopology(topologyName);
        }
      }
    });

    for (const id in mapURLs) {
      let layer = mapURLs[id];
      if (selectedTopologies.includes(layer.name)) {
        layer.display = true;
      } else {
        layer.display = false;
      }
    }

    onOptionsChange({ ...this.props.options });
  }

  configureAtlasEditorDisplay() {
    let { atlas, mapID } = this.state;

    /* 
    TODO: Maybe this would be cleaner/faster if I query Doc for the toolbar,
      query subset of controls from first result.
    */
    const params = urlUtil.getUrlSearchParams();
    if (params.editPanel != null && atlas) {
      // When in edit mode, enable mousewheel scrolling and show all toolbar elements
      atlas.map.scrollWheelZoom.enable();
      document
        .querySelectorAll<HTMLElement>(`#${mapID} .leaflet-control-zoom a`)
        .forEach((e) => (e.style.display = ''));
    } else if (atlas) {
      // Otherwise, disable scrolling, hide any toolbar elements that aren't zoom controls
      atlas.map.scrollWheelZoom.disable();
      document
        .querySelectorAll<HTMLElement>(`#${mapID} .leaflet-control-zoom :not([class*=leaflet-control-zoom-])`)
        .forEach((e) => (e.style.display = 'none'));

      atlas.editor.disableAllModes();
      if (atlas.editor.sidebar.sbContainer) {
        atlas.editor.hideSidebar();
      }
    }
  }

  getAllGroups() {
    const { atlas } = this.state;
    const groups = new Set<string>();
    if (!atlas) return [];
    for (const t in atlas.topologies) {
      atlas.topologies[t].lines.forEach((l: any) => {
        const g = l.metadata?.group;
        if (Array.isArray(g)) {
          g.forEach((x: string) => groups.add(x));
        } else if (g) {
          groups.add(g);
        }
      });
    }
    return [...groups].map(g => ({ label: g, value: g }));
  }

  applyGroupFilter(selectedGroups: string[]) {
    const { atlas } = this.state;
    if (!atlas) return;

    for (const t in atlas.topologies) {
      const topology = atlas.topologies[t];

      topology.lines.forEach((l: any) => {
        const g = l.metadata?.group;
        const lineGroups: string[] = Array.isArray(g) ? g : (g ? [g] : []);
        const visible = selectedGroups.length === 0 ||
                        lineGroups.some(x => selectedGroups.includes(x));
        try { visible ? l.show() : l.hide(); } catch (_) {}
      });
    }
  }

  render() {
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
      <div id={this.state.mapID} style={{ height: '100%' }}></div>

      {/* Existing map layer selector */}
      <div className={this.getMapSelectorClass().join(' ')}>
        <div
          className={cx(styles.toggleMapSelectorArea)}
          onClick={(e) =>
            this.setState((s) => {
              return { mapSelectorDisplay: !s.mapSelectorDisplay };
            })
          }
        >
          <Icon name={this.state.mapSelectorDisplay ? 'angle-right' : 'angle-left'} size="lg" />
        </div>
        <div className={cx(styles.selectorWrapper)}>
          <span className={cx(styles.layerName)}>Maps</span>
          <Select
            onChange={(e) => {
              this.setLayerDisplay(e);
            }}
            isMulti={true}
            options={this.getAllMapLayers()}
            value={this.getSelectedMapLayers()}
          />
        </div>
      </div>

      {/* Group filter */}
      <div
        style={{
          position: 'absolute',
          top: '10px',
          left: '10px',
          zIndex: 1000,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
        }}
      >
        {/* Toggle */}
        <div
          onClick={() => this.setState((s) => ({ groupSelectorDisplay: !s.groupSelectorDisplay }))}
          style={{
            background: 'var(--color-background-secondary, #22252b)',
            border: '1px solid var(--color-border-medium, #44444a)',
            borderRadius: '4px',
            padding: '4px 6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Icon name={this.state.groupSelectorDisplay ? 'angle-left' : 'angle-right'} size="lg" />
        </div>

        {/* Panel */}
        {this.state.groupSelectorDisplay && (
          <div
            style={{
              background: 'var(--color-background-secondary, #22252b)',
              border: '1px solid var(--color-border-medium, #44444a)',
              borderRadius: '4px',
              padding: '8px',
              marginLeft: '4px',
              minWidth: '220px',
            }}
          >
            <div
              style={{
                fontSize: '12px',
                marginBottom: '4px',
                color: 'var(--color-text-secondary, #aaa)',
              }}
            >
              Filter Groups
            </div>

            {/* ✅ PARENT GROUP SELECT (replaces old flat select but still supports flat data) */}
            <Select
              onChange={(selectedValues) => {
                const selected =
                  (selectedValues as Array<{ label: string; value: string }>) || [];

                this.setState({
                  groupFilter: selected,
                  subGroupFilter: [],
                });

                this.applyGroupFilterAdvanced(
                  selected.map((v) => v.value),
                  []
                );
              }}
              isMulti={true}
              placeholder="Select group..."
              options={this.getAllParentGroups()}
              value={this.state.groupFilter}
            />

            {/* ✅ SUBGROUP SELECT (only shows when applicable) */}
            {this.getSubGroups(this.state.groupFilter.map((v) => v.value)).length > 0 && (
              <div style={{ marginTop: '6px' }}>
                <Select
                  onChange={(selectedValues) => {
                    const selected =
                      (selectedValues as Array<{ label: string; value: string }>) || [];

                    this.setState({ subGroupFilter: selected });

                    this.applyGroupFilterAdvanced(
                      this.state.groupFilter.map((v) => v.value),
                      selected.map((v) => v.value)
                    );
                  }}
                  isMulti={true}
                  placeholder="Select subgroup..."
                  options={this.getSubGroups(
                    this.state.groupFilter.map((v) => v.value)
                  )}
                  value={this.state.subGroupFilter}
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