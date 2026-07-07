/**
 * WebGL-accelerated graph renderer for bulk node + edge drawing.
 *
 * Renders nodes as antialiased circles via instanced quads, and edges as
 * lines.  All 3000+ nodes/edges complete in ~2 draw calls instead of 3000+.
 *
 * Labels, glyphs, ripples, and other effects remain on a separate Canvas 2D
 * overlay for crisp text rendering.
 */
import createREGL, { type Regl } from 'regl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebGLNode {
  x: number;
  y: number;
  r: number;       // red   0-1
  g: number;       // green 0-1
  b: number;       // blue  0-1
  a: number;       // alpha 0-1
  radius: number;  // world-space radius
}

export interface WebGLEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface WebGLCamera {
  x: number;
  y: number;
  zoom: number;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Unit quad corners for instanced node rendering
// ---------------------------------------------------------------------------

// Six vertices forming two triangles of a unit quad from (-1,-1) to (1,1).
// Extended by 30% for antialiasing margin.
const QUAD_CORNERS = new Float32Array([
  -1.3, -1.3,  1.3, -1.3, -1.3,  1.3,
   1.3, -1.3,  1.3,  1.3, -1.3,  1.3,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildViewMatrix(cam: WebGLCamera): Float32Array {
  const { x, y, zoom, width, height } = cam;
  // Maps world coords to NDC:
  //   screenX = (worldX - cx) * zoom + width/2
  //   NDC_X   = screenX / width * 2 - 1   = (worldX - cx) * 2*zoom/width
  //   NDC_Y   = -(worldY - cy) * 2*zoom/height   (Y flipped for WebGL)
  const sx = (2 * zoom) / width;
  const sy = -(2 * zoom) / height;
  const tx = -sx * x;
  const ty = -sy * y;

  return new Float32Array([
    sx,  0, 0, 0,
     0, sy, 0, 0,
     0,  0, 1, 0,
    tx, ty, 0, 1,
  ]);
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export class GiopWebGLRenderer {
  private regl: Regl;
  private drawNodes: ReturnType<Regl['__createCommand']> | null = null;
  private drawEdges: ReturnType<Regl['__createCommand']> | null = null;
  private quadBuffer: ReturnType<Regl['buffer']> | null = null;
  private initialized = false;
  private gpuOk = false;

  constructor(private canvas: HTMLCanvasElement) {}

  /**
   * Quick hardware-GPU check without creating a full WebGL context.
   * Returns true if a real GPU (not llvmpipe/swiftshader fallback) is
   * likely available.  Call before init() so you can skip WebGL entirely.
   */
  static hasHardwareGPU(): boolean {
    try {
      const test = document.createElement('canvas');
      const gl = test.getContext('webgl') as WebGLRenderingContext | null;
      if (!gl) return false;

      // Get the debug renderer string — software fallbacks always advertise
      // themselves with distinctive names.
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL).toLowerCase();
        const softwareIndicators = [
          'llvmpipe', 'swiftshader', 'software', 'basic render',
          'gdi generic', 'microsoft basic', 'mesa x11',
        ];
        for (const kw of softwareIndicators) {
          if (renderer.includes(kw)) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /** One-time WebGL init. Returns true on success. */
  init(): boolean {
    if (this.initialized) return this.gpuOk;
    this.initialized = true;

    try {
      // Pre-check: if debug renderer reports software, don't even try regl
      if (!GiopWebGLRenderer.hasHardwareGPU()) {
        return false;
      }

      this.regl = createREGL({
        canvas: this.canvas,
        attributes: {
          alpha: true,
          premultipliedAlpha: false,
          antialias: false,
          preserveDrawingBuffer: false,
        },
      });
      this.gpuOk = true;
    } catch {
      return false;
    }

    this.quadBuffer = this.regl.buffer(QUAD_CORNERS);

    // --- node draw command (instanced quads → antialiased circles) ---
    this.drawNodes = this.regl({
      vert: `
        precision highp float;

        attribute vec2 aWorldPos;   // per-instance: node center in world space
        attribute vec4 aColor;      // per-instance: rgba
        attribute float aRadius;    // per-instance: world-space radius
        attribute vec2 aCorner;     // per-vertex: unit-quad corner offset

        uniform mat4 uView;

        varying vec4 vColor;
        varying vec2 vLocal;

        void main() {
          vec2 wp = aWorldPos + aCorner * aRadius;
          gl_Position = uView * vec4(wp, 0.0, 1.0);
          vColor = aColor;
          vLocal = aCorner / 1.3;  // normalize back to [-1,1]
        }
      `,

      frag: `
        precision highp float;

        varying vec4 vColor;
        varying vec2 vLocal;

        void main() {
          float d = length(vLocal);
          // Smooth antialiased circle edge
          float alpha = vColor.a * (1.0 - smoothstep(0.82, 1.0, d));
          if (alpha < 0.004) discard;
          gl_FragColor = vec4(vColor.rgb * alpha, alpha);
        }
      `,

      attributes: {
        aWorldPos: {
          buffer: this.regl.prop('nodePositions'),
          divisor: 1,
        },
        aColor: {
          buffer: this.regl.prop('nodeColors'),
          divisor: 1,
        },
        aRadius: {
          buffer: this.regl.prop('nodeRadii'),
          divisor: 1,
        },
        aCorner: this.quadBuffer,
      },

      uniforms: {
        uView: this.regl.prop('viewMatrix'),
      },

      count: 6,                         // 6 vertices per quad
      instances: this.regl.prop('nodeCount'),
      primitive: 'triangles',

      depth: { enable: false },
      blend: {
        enable: true,
        func: { src: 'src alpha', dst: 'one minus src alpha' },
        equation: 'add',
      },
    });

    // --- edge draw command (lines) ---
    this.drawEdges = this.regl({
      vert: `
        precision highp float;

        attribute vec2 aPosition;
        attribute vec4 aColor;

        uniform mat4 uView;

        varying vec4 vColor;

        void main() {
          gl_Position = uView * vec4(aPosition, 0.0, 1.0);
          vColor = aColor;
        }
      `,

      frag: `
        precision highp float;

        varying vec4 vColor;

        void main() {
          if (vColor.a < 0.005) discard;
          gl_FragColor = vColor;
        }
      `,

      attributes: {
        aPosition: this.regl.prop('edgePositions'),
        aColor: this.regl.prop('edgeColors'),
      },

      uniforms: {
        uView: this.regl.prop('viewMatrix'),
      },

      count: this.regl.prop('edgeVertCount'),
      primitive: 'lines',

      depth: { enable: false },
      blend: {
        enable: true,
        func: { src: 'src alpha', dst: 'one minus src alpha' },
        equation: 'add',
      },
    });
  }

  /** Render all nodes in one instanced draw call. */
  drawNodeBatch(nodes: WebGLNode[], camera: WebGLCamera): void {
    if (!this.gpuOk || !this.drawNodes || nodes.length === 0) return;

    const n = nodes.length;
    const posBuf = new Float32Array(n * 2);
    const colBuf = new Float32Array(n * 4);
    const radBuf = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      posBuf[i * 2 + 0] = node.x;
      posBuf[i * 2 + 1] = node.y;
      colBuf[i * 4 + 0] = node.r;
      colBuf[i * 4 + 1] = node.g;
      colBuf[i * 4 + 2] = node.b;
      colBuf[i * 4 + 3] = node.a;
      radBuf[i] = node.radius;
    }

    (this.drawNodes as any)({
      nodePositions: posBuf,
      nodeColors: colBuf,
      nodeRadii: radBuf,
      nodeCount: n,
      viewMatrix: buildViewMatrix(camera),
    });
  }

  /** Render all edges in one line draw call. */
  drawEdgeBatch(edges: WebGLEdge[], camera: WebGLCamera): void {
    if (!this.gpuOk || !this.drawEdges || edges.length === 0) return;

    const n = edges.length;
    const posBuf = new Float32Array(n * 4);   // 2 vertices × 2 floats
    const colBuf = new Float32Array(n * 8);   // 2 vertices × 4 floats

    for (let i = 0; i < n; i++) {
      const e = edges[i];
      const pi = i * 4;
      const ci = i * 8;
      posBuf[pi + 0] = e.x1;
      posBuf[pi + 1] = e.y1;
      posBuf[pi + 2] = e.x2;
      posBuf[pi + 3] = e.y2;
      for (let v = 0; v < 2; v++) {
        colBuf[ci + v * 4 + 0] = e.r;
        colBuf[ci + v * 4 + 1] = e.g;
        colBuf[ci + v * 4 + 2] = e.b;
        colBuf[ci + v * 4 + 3] = e.a;
      }
    }

    (this.drawEdges as any)({
      edgePositions: posBuf,
      edgeColors: colBuf,
      edgeVertCount: n * 2,
      viewMatrix: buildViewMatrix(camera),
    });
  }

  /** Clear the WebGL canvas with a themed background. */
  clear(isLight: boolean): void {
    if (!this.gpuOk) return;
    // These match the Canvas 2D palette: dark #121212 / light #e0e7f1
    const bg = isLight ? [0.878, 0.906, 0.945, 1.0] : [0.071, 0.071, 0.071, 1.0];
    this.regl.clear({ color: bg as any, depth: 1 });
  }

  /** Set canvas size in CSS and drawing-buffer pixels. */
  resize(width: number, height: number, dpr: number): void {
    this.canvas.width = Math.floor(width * dpr);
    this.canvas.height = Math.floor(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    if (this.initialized && this.gpuOk) {
      this.regl.poll();
    }
  }

  /** Destroy the regl context. */
  destroy(): void {
    if (this.initialized && this.gpuOk) {
      this.regl.destroy();
    }
    this.initialized = false;
    this.gpuOk = false;
    this.drawNodes = null;
    this.drawEdges = null;
    this.quadBuffer = null;
  }
}
