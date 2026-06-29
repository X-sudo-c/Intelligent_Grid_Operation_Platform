import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-csp-worker.js?url';

// Vite splits the worker from the main bundle — Martin MVT tiles need this to parse.
maplibregl.workerUrl = workerUrl;

export default maplibregl;
