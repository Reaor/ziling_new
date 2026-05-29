export class Renderer {
  constructor(canvasId) {
    this.canvas = document.getElementById(canvasId);
    this.ctx = null;
    this.cssWidth = 0;
    this.cssHeight = 0;
  }

  init() {
    const container = document.getElementById('app-container');
    this.cssWidth = container.clientWidth;
    this.cssHeight = container.clientHeight;
    
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = this.cssWidth * dpr;
    this.canvas.height = this.cssHeight * dpr;
    this.canvas.style.width = this.cssWidth + 'px';
    this.canvas.style.height = this.cssHeight + 'px';
    
    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(dpr, dpr);
    this.ctx.textBaseline = 'top';
    this.ctx.imageSmoothingEnabled = true;
    
    console.log(`Canvas initialized: ${this.cssWidth}x${this.cssHeight}, DPR=${dpr}`);
    
    return { ctx: this.ctx, cssWidth: this.cssWidth, cssHeight: this.cssHeight };
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  getContext() {
    return this.ctx;
  }
}
