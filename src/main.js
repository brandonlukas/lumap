import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

class LumapVisualizer {
    constructor() {
        this.scene = new THREE.Scene();
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.composer = null;
        this.pointCloud = null;
        this.bloomPass = null;

        // Cell type data for highlighting
        this.cellTypes = null;          // Uint8Array of cell type indices
        this.cellTypeNames = null;      // Array of cell type names
        this.originalColors = null;     // Float32Array of original colors
        this.highlightedType = null;    // Currently highlighted cell type (null = none)

        // Multi-attribute support
        this.attributes = null;         // Metadata about all attributes
        this.currentAttribute = null;   // Currently selected attribute
        this.attributeData = {};        // Map of attribute name -> Uint8Array

        this.defaultSettings = {
            pointSize: 0.15,
            bloomStrength: 1.2,
            bloomRadius: 0.5,
            autoRotate: true,
            backgroundDark: true
        };

        this.settings = { ...this.defaultSettings };

        this.stats = {
            fps: 0,
            pointCount: 0,
            lastTime: performance.now(),
            frames: 0
        };

        this.init();
    }

    async init() {
        this.setupRenderer();
        this.setupCamera();
        this.setupControls();
        this.setupPostProcessing();
        this.setupEventListeners();
        await this.loadPointCloud();
        this.hideLoading();
        this.animate();
    }

    setupRenderer() {
        const container = document.getElementById('canvas-container');

        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            powerPreference: 'high-performance'
        });

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000);

        container.appendChild(this.renderer.domElement);
    }

    setupCamera() {
        this.camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        this.camera.position.set(0, 0, 50);
    }

    setupControls() {
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.autoRotate = this.settings.autoRotate;
        this.controls.autoRotateSpeed = 0.5;
        this.controls.minDistance = 10;
        this.controls.maxDistance = 200;
    }

    setupPostProcessing() {
        this.composer = new EffectComposer(this.renderer);
        const renderPass = new RenderPass(this.scene, this.camera);
        this.composer.addPass(renderPass);

        this.bloomPass = new UnrealBloomPass(
            new THREE.Vector2(window.innerWidth, window.innerHeight),
            this.settings.bloomStrength,
            this.settings.bloomRadius,
            this.settings.bloomThreshold
        );
        this.composer.addPass(this.bloomPass);
    }

    async loadPointCloud() {
        try {
            // Load attributes metadata first
            let attributesResponse = null;
            try {
                attributesResponse = await fetch('/data/attributes.json').then(r => r.ok ? r.json() : null).catch(() => null);
            } catch (e) {
                console.log('No attributes.json found');
            }

            if (attributesResponse) {
                this.attributes = attributesResponse;
                this.currentAttribute = attributesResponse.default_attribute;
                console.log(`Available attributes: ${Object.keys(attributesResponse.attributes).join(', ')}`);
                console.log(`Default attribute: ${this.currentAttribute}`);
            }

            const [coordsBuffer, colorsBuffer] = await Promise.all([
                fetch('/data/coords.bin').then(r => r.arrayBuffer()),
                fetch('/data/colors.bin').then(r => r.arrayBuffer())
            ]);

            const coords = new Float32Array(coordsBuffer);
            const colors = new Uint8Array(colorsBuffer);

            const pointCount = coords.length / 3;
            this.stats.pointCount = pointCount;

            // Load all attribute data if metadata available
            if (this.attributes) {
                const attrNames = Object.keys(this.attributes.attributes);
                const attrFetches = attrNames.map(name =>
                    fetch(`/data/attribute_${name}.bin`)
                        .then(r => r.ok ? r.arrayBuffer() : null)
                        .catch(() => null)
                );
                const attrBuffers = await Promise.all(attrFetches);

                for (let i = 0; i < attrNames.length; i++) {
                    if (attrBuffers[i]) {
                        this.attributeData[attrNames[i]] = new Uint8Array(attrBuffers[i]);
                    }
                }

                // Set first attribute data for backward compatibility
                if (this.currentAttribute && this.attributeData[this.currentAttribute]) {
                    this.cellTypes = this.attributeData[this.currentAttribute];
                    this.cellTypeNames = this.attributes.attributes[this.currentAttribute].names;
                    console.log(`Loaded ${this.currentAttribute}: ${this.cellTypeNames?.join(', ') || 'no names'}`);
                }
            }

            // Fallback for old format (celltype.bin directly)
            if (!this.cellTypes) {
                try {
                    const cellTypeBuffer = await fetch('/data/celltype.bin').then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
                    const cellTypeNamesResponse = await fetch('/data/celltype_names.json').then(r => r.ok ? r.json() : null).catch(() => null);

                    if (cellTypeBuffer && cellTypeNamesResponse) {
                        this.cellTypes = new Uint8Array(cellTypeBuffer);
                        this.cellTypeNames = cellTypeNamesResponse.names;
                        this.currentAttribute = 'celltype';
                    }
                } catch (e) {
                    console.log('No celltype data found');
                }
            }

            // Populate UI with attribute options
            this.populateAttributeDropdown();
            if (this.cellTypes && this.cellTypeNames) {
                this.populateCellTypeDropdown();
            } else {
                const highlightDropdown = document.getElementById('highlight-celltype');
                if (highlightDropdown) {
                    highlightDropdown.disabled = true;
                    highlightDropdown.value = '';
                }
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(coords, 3));

            const colorFloats = new Float32Array(colors.length);
            for (let i = 0; i < colors.length; i++) {
                colorFloats[i] = colors[i] / 255;
            }

            // Store original colors for highlighting
            this.originalColors = new Float32Array(colorFloats);

            geometry.setAttribute('color', new THREE.BufferAttribute(colorFloats, 3));

            // Load correct color variant for the default attribute if available
            if (this.currentAttribute && this.attributes && this.attributes.attributes[this.currentAttribute]) {
                try {
                    const attrColorBuffer = await fetch(`/data/colors_${this.currentAttribute}.bin`).then(r => r.arrayBuffer());
                    const attrColors = new Uint8Array(attrColorBuffer);

                    for (let i = 0; i < attrColors.length; i++) {
                        colorFloats[i] = attrColors[i] / 255;
                    }

                    this.originalColors = new Float32Array(colorFloats);
                    geometry.attributes.color.array = new Float32Array(colorFloats);
                    geometry.attributes.color.needsUpdate = true;

                    console.log(`Loaded initial colors for ${this.currentAttribute}`);
                } catch (e) {
                    console.log(`Could not load attribute colors: ${e}`);
                }
            }

            // Add brightness attribute for highlighting (1.0 = full brightness, 0.0 = dimmed)
            const brightness = new Float32Array(pointCount).fill(1.0);
            geometry.setAttribute('brightness', new THREE.BufferAttribute(brightness, 1));

            geometry.computeBoundingSphere();
            const center = geometry.boundingSphere.center;
            geometry.translate(-center.x, -center.y, -center.z);

            const material = new THREE.ShaderMaterial({
                uniforms: {
                    pointSize: { value: this.settings.pointSize }
                },
                vertexShader: `
          attribute vec3 color;
          attribute float brightness;
          uniform float pointSize;
          varying vec3 vColor;
          varying float vBrightness;
          
          void main() {
            vColor = color;
            vBrightness = brightness;
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            gl_PointSize = pointSize * (400.0 / -mvPosition.z);
            gl_Position = projectionMatrix * mvPosition;
          }
        `,
                fragmentShader: `
          varying vec3 vColor;
          varying float vBrightness;
          
          void main() {
            vec2 center = gl_PointCoord - vec2(0.5);
            float dist = length(center);
            
            if (dist > 0.5) discard;
            
            float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
            alpha = pow(alpha, 1.2);
            
            // Reduce alpha for dimmed points (less bloom)
            alpha *= vBrightness;
            
            gl_FragColor = vec4(vColor, alpha * 0.9);
          }
        `,
                transparent: true,
                blending: THREE.AdditiveBlending,
                depthWrite: false
            });

            this.pointCloud = new THREE.Points(geometry, material);
            this.scene.add(this.pointCloud);

            const radius = geometry.boundingSphere.radius;
            const fittingDistance = radius * 2.5;
            this.camera.position.setLength(fittingDistance);
            this.controls.update();

            console.log(`Loaded ${pointCount.toLocaleString()} points`);
        } catch (error) {
            console.error('Error loading point cloud:', error);
            document.getElementById('loading').innerHTML =
                '<div style="color: #ff4444;">Error loading data. Please check console.</div>';
        }
    }

    setupEventListeners() {
        window.addEventListener('resize', () => this.onWindowResize(), false);

        const pointSizeSlider = document.getElementById('point-size');
        const pointSizeValue = document.getElementById('point-size-value');
        pointSizeSlider.value = this.settings.pointSize;
        pointSizeValue.textContent = this.settings.pointSize.toFixed(2);
        pointSizeSlider.addEventListener('input', (e) => {
            this.settings.pointSize = parseFloat(e.target.value);
            pointSizeValue.textContent = this.settings.pointSize.toFixed(2);
            if (this.pointCloud) {
                this.pointCloud.material.uniforms.pointSize.value = this.settings.pointSize;
            }
        });

        const pointFalloffSlider = document.getElementById('point-falloff');
        if (pointFalloffSlider) {
            const pointFalloffValue = document.getElementById('point-falloff-value');
            pointFalloffSlider.addEventListener('input', (e) => {
                this.settings.pointFalloff = parseFloat(e.target.value);
                pointFalloffValue.textContent = this.settings.pointFalloff.toFixed(2);
                if (this.pointCloud) {
                    this.pointCloud.material.uniforms.pointFalloff.value = this.settings.pointFalloff;
                }
            });
        }

        const gammaSlider = document.getElementById('gamma');
        if (gammaSlider) {
            const gammaValue = document.getElementById('gamma-value');
            gammaSlider.addEventListener('input', (e) => {
                this.settings.gamma = parseFloat(e.target.value);
                gammaValue.textContent = this.settings.gamma.toFixed(2);
                if (this.pointCloud) {
                    this.pointCloud.material.uniforms.gamma.value = this.settings.gamma;
                }
            });
        }

        const saturateSlider = document.getElementById('saturate');
        if (saturateSlider) {
            const saturateValue = document.getElementById('saturate-value');
            saturateSlider.addEventListener('input', (e) => {
                this.settings.saturate = parseFloat(e.target.value);
                saturateValue.textContent = this.settings.saturate.toFixed(2);
                if (this.pointCloud) {
                    this.pointCloud.material.uniforms.saturate.value = this.settings.saturate;
                }
            });
        }

        const bloomStrengthSlider = document.getElementById('bloom-strength');
        const bloomStrengthValue = document.getElementById('bloom-strength-value');
        bloomStrengthSlider.addEventListener('input', (e) => {
            this.settings.bloomStrength = parseFloat(e.target.value);
            bloomStrengthValue.textContent = this.settings.bloomStrength.toFixed(2);
            this.bloomPass.strength = this.settings.bloomStrength;
        });

        const bloomRadiusSlider = document.getElementById('bloom-radius');
        const bloomRadiusValue = document.getElementById('bloom-radius-value');
        bloomRadiusSlider.addEventListener('input', (e) => {
            this.settings.bloomRadius = parseFloat(e.target.value);
            bloomRadiusValue.textContent = this.settings.bloomRadius.toFixed(2);
            this.bloomPass.radius = this.settings.bloomRadius;
        });

        const autoRotateBtn = document.getElementById('auto-rotate');
        const updateAutoRotateUI = () => {
            autoRotateBtn.textContent = `Auto Rotate: ${this.settings.autoRotate ? 'ON' : 'OFF'}`;
            autoRotateBtn.classList.toggle('active', this.settings.autoRotate);
        };
        updateAutoRotateUI();
        this.controls.autoRotate = this.settings.autoRotate;
        autoRotateBtn.addEventListener('click', () => {
            this.settings.autoRotate = !this.settings.autoRotate;
            this.controls.autoRotate = this.settings.autoRotate;
            updateAutoRotateUI();
        });

        const bgToggleBtn = document.getElementById('background-toggle');
        bgToggleBtn.addEventListener('click', () => {
            this.settings.backgroundDark = !this.settings.backgroundDark;
            const color = this.settings.backgroundDark ? 0x000000 : 0x0a0a0a;
            this.renderer.setClearColor(color);
            bgToggleBtn.textContent = `Background: ${this.settings.backgroundDark ? 'Black' : 'Dark Gray'}`;
        });

        const resetBtn = document.getElementById('reset-defaults');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.settings = { ...this.defaultSettings };
                this.applySettingsToUI();
            });
        }

        const highlightDropdown = document.getElementById('highlight-celltype');
        if (highlightDropdown) {
            highlightDropdown.addEventListener('change', (e) => {
                const value = e.target.value;
                this.updateHighlight(value === '' ? null : value);
            });
        }

        const colorByDropdown = document.getElementById('color-by-attribute');
        if (colorByDropdown) {
            colorByDropdown.addEventListener('change', (e) => {
                this.switchAttribute(e.target.value);
            });
        }

        const toggleAdvancedBtn = document.getElementById('toggle-advanced');
        if (toggleAdvancedBtn) {
            const advancedControls = document.getElementById('advanced-controls');
            toggleAdvancedBtn.addEventListener('click', () => {
                advancedControls.style.display = advancedControls.style.display === 'none' ? 'block' : 'none';
                toggleAdvancedBtn.textContent = advancedControls.style.display === 'none' ? '+ Advanced' : '- Advanced';
            });
        }

        this.applySettingsToUI();
    }

    applySettingsToUI() {
        const pointSizeSlider = document.getElementById('point-size');
        const pointSizeValue = document.getElementById('point-size-value');
        if (pointSizeSlider && pointSizeValue) {
            pointSizeSlider.value = this.settings.pointSize;
            pointSizeValue.textContent = this.settings.pointSize.toFixed(2);
            if (this.pointCloud) {
                this.pointCloud.material.uniforms.pointSize.value = this.settings.pointSize;
            }
        }

        const bloomStrengthSlider = document.getElementById('bloom-strength');
        const bloomStrengthValue = document.getElementById('bloom-strength-value');
        if (bloomStrengthSlider && bloomStrengthValue) {
            bloomStrengthSlider.value = this.settings.bloomStrength;
            bloomStrengthValue.textContent = this.settings.bloomStrength.toFixed(2);
            if (this.bloomPass) {
                this.bloomPass.strength = this.settings.bloomStrength;
            }
        }

        const bloomRadiusSlider = document.getElementById('bloom-radius');
        const bloomRadiusValue = document.getElementById('bloom-radius-value');
        if (bloomRadiusSlider && bloomRadiusValue) {
            bloomRadiusSlider.value = this.settings.bloomRadius;
            bloomRadiusValue.textContent = this.settings.bloomRadius.toFixed(2);
            if (this.bloomPass) {
                this.bloomPass.radius = this.settings.bloomRadius;
            }
        }

        const autoRotateBtn = document.getElementById('auto-rotate');
        if (autoRotateBtn) {
            autoRotateBtn.textContent = `Auto Rotate: ${this.settings.autoRotate ? 'ON' : 'OFF'}`;
            autoRotateBtn.classList.toggle('active', this.settings.autoRotate);
        }
        if (this.controls) {
            this.controls.autoRotate = this.settings.autoRotate;
        }

        const bgToggleBtn = document.getElementById('background-toggle');
        if (bgToggleBtn) {
            const color = this.settings.backgroundDark ? 0x000000 : 0x0a0a0a;
            this.renderer.setClearColor(color);
            bgToggleBtn.textContent = `Background: ${this.settings.backgroundDark ? 'Black' : 'Dark Gray'}`;
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.composer.setSize(window.innerWidth, window.innerHeight);
    }

    updateStats() {
        this.stats.frames++;
        const currentTime = performance.now();
        const elapsed = currentTime - this.stats.lastTime;

        if (elapsed >= 1000) {
            this.stats.fps = Math.round((this.stats.frames * 1000) / elapsed);
            this.stats.frames = 0;
            this.stats.lastTime = currentTime;

            const statsDiv = document.getElementById('stats');
            statsDiv.innerHTML = `
        FPS: ${this.stats.fps}<br>
        Points: ${this.stats.pointCount.toLocaleString()}
      `;
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.composer.render();
        this.updateStats();
    }

    hideLoading() {
        document.getElementById('loading').style.display = 'none';
        document.getElementById('controls').style.display = 'block';
    }

    populateCellTypeDropdown() {
        const dropdown = document.getElementById('highlight-celltype');
        if (!dropdown || !this.cellTypeNames) return;

        // Clear existing options except "None"
        dropdown.innerHTML = '<option value="">None (show all)</option>';

        // Add cell type options
        this.cellTypeNames.forEach((name, index) => {
            const option = document.createElement('option');
            option.value = index;
            option.textContent = name.replace(/_/g, ' ');
            dropdown.appendChild(option);
        });
    }

    populateAttributeDropdown() {
        const dropdown = document.getElementById('color-by-attribute');
        if (!dropdown) return;

        dropdown.innerHTML = '';

        // Always show None option
        const noneOption = document.createElement('option');
        noneOption.value = 'none';
        noneOption.textContent = 'None (white)';
        dropdown.appendChild(noneOption);

        if (!this.attributes) {
            dropdown.value = 'none';
            dropdown.disabled = true;
            return;
        }

        dropdown.disabled = false;
        const attrNames = Object.keys(this.attributes.attributes);

        attrNames.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name.replace(/_/g, ' ');
            if (name === this.currentAttribute) {
                option.selected = true;
            }
            dropdown.appendChild(option);
        });
    }

    async switchAttribute(attrName) {
        if (!attrName) return;

        // Handle "None" option - set all points to white
        if (attrName === 'none') {
            this.currentAttribute = null;
            this.cellTypes = null;
            this.cellTypeNames = null;

            console.log('Switched to None - displaying white points');

            // Clear highlight dropdown
            const highlightDropdown = document.getElementById('highlight-celltype');
            if (highlightDropdown) {
                highlightDropdown.innerHTML = '<option value="">None (show all)</option>';
                highlightDropdown.disabled = true;
            }

            // Set all points to white
            if (this.pointCloud) {
                const colorAttribute = this.pointCloud.geometry.attributes.color;
                const brightnessAttribute = this.pointCloud.geometry.attributes.brightness;
                const pointCount = colorAttribute.array.length / 3;

                for (let i = 0; i < pointCount; i++) {
                    colorAttribute.array[i * 3] = 1.0;     // R
                    colorAttribute.array[i * 3 + 1] = 1.0; // G
                    colorAttribute.array[i * 3 + 2] = 1.0; // B
                    brightnessAttribute.array[i] = 1.0;    // Full brightness
                }

                // Store white as original colors
                this.originalColors = new Float32Array(colorAttribute.array);

                colorAttribute.needsUpdate = true;
                brightnessAttribute.needsUpdate = true;
            }

            return;
        }

        // Handle regular attribute selection
        if (!this.attributeData[attrName]) return;

        this.currentAttribute = attrName;
        this.cellTypes = this.attributeData[attrName];
        this.cellTypeNames = this.attributes.attributes[attrName].names;

        console.log(`Switched to attribute: ${attrName}`);
        this.populateCellTypeDropdown();

        // Re-enable highlight dropdown
        const highlightDropdown = document.getElementById('highlight-celltype');
        if (highlightDropdown) {
            highlightDropdown.disabled = false;
        }

        // Load corresponding color variant
        try {
            const colorBuffer = await fetch(`/data/colors_${attrName}.bin`).then(r => r.arrayBuffer());
            const colors = new Uint8Array(colorBuffer);

            const colorFloats = new Float32Array(colors.length);
            for (let i = 0; i < colors.length; i++) {
                colorFloats[i] = colors[i] / 255;
            }

            this.originalColors = new Float32Array(colorFloats);

            if (this.pointCloud) {
                const colorAttribute = this.pointCloud.geometry.attributes.color;
                for (let i = 0; i < colorFloats.length; i++) {
                    colorAttribute.array[i] = colorFloats[i];
                }
                colorAttribute.needsUpdate = true;
            }

            // Reset highlight
            const dropdown = document.getElementById('highlight-celltype');
            if (dropdown) {
                dropdown.value = '';
            }
            this.updateHighlight('');
        } catch (e) {
            console.error(`Error loading colors for ${attrName}:`, e);
        }
    }

    updateHighlight(cellTypeIndex) {
        if (!this.cellTypes || !this.pointCloud) return;

        const colorAttribute = this.pointCloud.geometry.attributes.color;
        const brightnessAttribute = this.pointCloud.geometry.attributes.brightness;
        const colors = colorAttribute.array;
        const brightness = brightnessAttribute.array;

        if (cellTypeIndex === null || cellTypeIndex === '') {
            // No highlight - restore all original colors and full brightness
            for (let i = 0; i < this.originalColors.length; i++) {
                colors[i] = this.originalColors[i];
            }
            for (let i = 0; i < brightness.length; i++) {
                brightness[i] = 1.0;
            }
            this.highlightedType = null;
        } else {
            // Highlight selected cell type
            const selectedType = parseInt(cellTypeIndex);
            this.highlightedType = selectedType;

            for (let i = 0; i < this.cellTypes.length; i++) {
                const isSelected = this.cellTypes[i] === selectedType;
                const baseIdx = i * 3;

                if (isSelected) {
                    // Keep original colors and full brightness for selected type
                    colors[baseIdx] = this.originalColors[baseIdx];
                    colors[baseIdx + 1] = this.originalColors[baseIdx + 1];
                    colors[baseIdx + 2] = this.originalColors[baseIdx + 2];
                    brightness[i] = 1.0;
                } else {
                    // Dim and desaturate non-selected points (light gray, reduced bloom)
                    colors[baseIdx] = 0.2;
                    colors[baseIdx + 1] = 0.2;
                    colors[baseIdx + 2] = 0.2;
                    brightness[i] = 0.15;  // Significantly reduce bloom for background points
                }
            }
        }

        colorAttribute.needsUpdate = true;
        brightnessAttribute.needsUpdate = true;
    }
}

new LumapVisualizer();
