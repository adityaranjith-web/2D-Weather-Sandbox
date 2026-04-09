/**
 * globe.js — 3D Globe View for 2D Weather Sandbox
 *
 * Renders the simulation canvas as a live texture on a Three.js sphere.
 * The physics simulation is completely untouched — this is display-only.
 *
 * How it works:
 *   1. Three.js CanvasTexture reads #mainCanvas every frame (preserveDrawingBuffer:true)
 *   2. The canvas image is mapped onto a sphere
 *   3. Clicking the globe raycasts to a UV coordinate, then injects synthetic
 *      mouse events into the sim at the matching canvas position
 *
 * UV → canvas mapping (Three.js SphereGeometry + CanvasTexture flipY=true):
 *   uv.x  → horizontal (u=0 left  … u=1 right)
 *   uv.y  → vertical   (v=0 canvas-bottom/ground … v=1 canvas-top/sky)
 *   canvas_x = uv.x * canvas.width
 *   canvas_y = (1 - uv.y) * canvas.height   ← flip because canvas Y is top-down
 */

(function () {
    'use strict';

    // ─── State ────────────────────────────────────────────────────────────────
    var isGlobeActive = false;

    var scene, camera, renderer, globe, weatherTexture;
    var raycaster, mouseNDC;

    // Orbit state
    var isDragging      = false;
    var hasDragged      = false;
    var dragStart       = { x: 0, y: 0 };
    var prevMouse       = { x: 0, y: 0 };
    var sphericalTheta  = 0;             // azimuth  (horizontal spin)
    var sphericalPhi    = Math.PI / 2;   // polar    (0=top, π=bottom)
    var cameraRadius    = 2.8;
    var autoRotate      = true;
    var lastInteraction = 0;
    var RESUME_DELAY    = 2500;          // ms idle before auto-rotate kicks in

    // ─── Init ─────────────────────────────────────────────────────────────────
    function init() {
        if (typeof THREE === 'undefined') {
            console.warn('[globe.js] THREE.js not found — globe view disabled');
            var btn = document.getElementById('gp-globe-toggle');
            if (btn) { btn.disabled = true; btn.title = 'Requires Three.js (CDN unavailable)'; }
            return;
        }

        var gc = document.getElementById('globeCanvas');
        if (!gc) { console.warn('[globe.js] #globeCanvas not found'); return; }

        // Scene & camera
        scene  = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(45, aspectRatio(), 0.1, 2000);

        // Renderer
        renderer = new THREE.WebGLRenderer({ canvas: gc, antialias: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x000008, 1); // deep-space black

        buildStarfield();
        buildGlobe();
        buildAtmosphereHalo();
        buildLights();

        raycaster = new THREE.Raycaster();
        mouseNDC  = new THREE.Vector2();

        // Globe canvas events
        gc.addEventListener('mousedown',  onDown,  false);
        gc.addEventListener('mousemove',  onMove,  false);
        gc.addEventListener('mouseup',    onUp,    false);
        gc.addEventListener('mouseleave', onLeave, false);
        gc.addEventListener('wheel',      onWheel, { passive: false });

        window.addEventListener('resize', onWindowResize, false);

        requestAnimationFrame(renderLoop);

        console.log('[globe.js] initialised');
    }

    function aspectRatio() {
        return window.innerWidth / window.innerHeight;
    }

    // ─── Scene construction ────────────────────────────────────────────────────
    function buildStarfield() {
        var count    = 12000;
        var positions = new Float32Array(count * 3);
        for (var i = 0; i < count; i++) {
            var theta = Math.random() * Math.PI * 2;
            var phi   = Math.acos(2 * Math.random() - 1);
            var r     = 500 + Math.random() * 300;
            positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
            positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
            positions[i * 3 + 2] = r * Math.cos(phi);
        }
        var geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        var mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, sizeAttenuation: true });
        scene.add(new THREE.Points(geo, mat));
    }

    function buildGlobe() {
        var simCanvas  = document.getElementById('mainCanvas');
        weatherTexture = new THREE.CanvasTexture(simCanvas);
        weatherTexture.minFilter = THREE.LinearFilter;
        weatherTexture.magFilter = THREE.LinearFilter;
        // flipY = true (default) — Three.js flips canvas Y when uploading as texture,
        // so v=0 at the canvas-bottom (ground) and v=1 at the canvas-top (sky).

        var geo = new THREE.SphereGeometry(1, 96, 96);
        var mat = new THREE.MeshPhongMaterial({
            map:       weatherTexture,
            specular:  new THREE.Color(0x223344),
            shininess: 12
        });
        globe = new THREE.Mesh(geo, mat);
        scene.add(globe);
    }

    function buildAtmosphereHalo() {
        // Slightly larger back-face sphere for a thin blue glow
        var geo = new THREE.SphereGeometry(1.03, 64, 64);
        var mat = new THREE.MeshPhongMaterial({
            color:       0x3366cc,
            side:        THREE.BackSide,
            transparent: true,
            opacity:     0.10,
            depthWrite:  false
        });
        scene.add(new THREE.Mesh(geo, mat));
    }

    function buildLights() {
        // Soft fill
        scene.add(new THREE.AmbientLight(0x446688, 0.55));
        // Sun-like key light
        var sun = new THREE.DirectionalLight(0xfff0dd, 1.15);
        sun.position.set(6, 3, 5);
        scene.add(sun);
        // Subtle back-fill
        var fill = new THREE.DirectionalLight(0x223366, 0.25);
        fill.position.set(-4, -1, -3);
        scene.add(fill);
    }

    // ─── Render loop ───────────────────────────────────────────────────────────
    function renderLoop() {
        requestAnimationFrame(renderLoop);
        if (!isGlobeActive) return;

        // Pull the latest sim frame into the sphere texture every cycle
        if (weatherTexture) weatherTexture.needsUpdate = true;

        // Resume auto-rotate after user has been idle
        if (!isDragging && Date.now() - lastInteraction > RESUME_DELAY) {
            autoRotate = true;
        }
        if (autoRotate) {
            sphericalTheta += 0.0025;
        }

        // Position camera on the spherical shell looking at origin
        camera.position.set(
            cameraRadius * Math.sin(sphericalPhi) * Math.sin(sphericalTheta),
            cameraRadius * Math.cos(sphericalPhi),
            cameraRadius * Math.sin(sphericalPhi) * Math.cos(sphericalTheta)
        );
        camera.lookAt(0, 0, 0);

        renderer.render(scene, camera);
    }

    // ─── Mouse / wheel handlers ────────────────────────────────────────────────
    function onDown(e) {
        if (e.button !== 0) return;
        isDragging      = true;
        hasDragged      = false;
        dragStart       = { x: e.clientX, y: e.clientY };
        prevMouse       = { x: e.clientX, y: e.clientY };
        autoRotate      = false;
        lastInteraction = Date.now();

        // If a god-tool is active, begin a paint stroke on the sim
        if (hasActiveTool()) {
            injectSimDown(e.clientX, e.clientY);
        }
    }

    function onMove(e) {
        if (!isDragging) return;

        var dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
        if (dist > 5) hasDragged = true;

        if (hasActiveTool()) {
            // Drag-paint: keep leftMousePressed true in sim, update position
            injectSimMove(e.clientX, e.clientY);
        } else {
            // Orbit: rotate the globe
            sphericalTheta -= (e.clientX - prevMouse.x) * 0.005;
            sphericalPhi   -= (e.clientY - prevMouse.y) * 0.005;
            sphericalPhi    = Math.max(0.15, Math.min(Math.PI - 0.15, sphericalPhi));
        }

        prevMouse       = { x: e.clientX, y: e.clientY };
        lastInteraction = Date.now();
    }

    function onUp(e) {
        if (e.button !== 0) return;
        if (hasActiveTool()) {
            injectSimUp();
        }
        isDragging      = false;
        lastInteraction = Date.now();
    }

    function onLeave() {
        if (isDragging && hasActiveTool()) injectSimUp();
        isDragging = false;
    }

    function onWheel(e) {
        e.preventDefault();
        cameraRadius   += e.deltaY * 0.004;
        cameraRadius    = Math.max(1.4, Math.min(10, cameraRadius));
        autoRotate      = false;
        lastInteraction = Date.now();
    }

    function onWindowResize() {
        if (!camera || !renderer) return;
        camera.aspect = aspectRatio();
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    // ─── Tool injection ────────────────────────────────────────────────────────
    function hasActiveTool() {
        return window.guiControls && window.guiControls.tool !== 'TOOL_NONE';
    }

    /**
     * Raycast against the globe and return the UV at the hit point, or null.
     */
    function getHitUV(clientX, clientY) {
        if (!globe) return null;
        mouseNDC.x = (clientX  / window.innerWidth)  *  2 - 1;
        mouseNDC.y = (clientY  / window.innerHeight) * -2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);
        var hits = raycaster.intersectObject(globe);
        return hits.length ? hits[0].uv : null;
    }

    /**
     * Convert a Three.js sphere UV to canvas pixel coordinates.
     *
     * Three.js CanvasTexture uploads with flipY=true, meaning:
     *   texture v=0  ←→  canvas row 0  (top = high atmosphere)
     *   texture v=1  ←→  canvas last row (bottom = ground)
     *
     * SphereGeometry stores uv.y = 1 - v_sphere, so the raycaster
     * returns uv.y=1 near north-pole (canvas top = sky) and
     * uv.y=0 near south-pole (canvas bottom = ground).
     *
     * Therefore:  canvas_y = (1 - uv.y) * canvas.height
     */
    function uvToCanvasPos(uv) {
        var mc = document.getElementById('mainCanvas');
        return {
            x: uv.x * mc.width,
            y: (1 - uv.y) * mc.height
        };
    }

    // Inject a mousedown into the sim canvas at the globe click position
    function injectSimDown(clientX, clientY) {
        var uv = getHitUV(clientX, clientY);
        if (!uv) return;
        var pos = uvToCanvasPos(uv);
        var mc  = document.getElementById('mainCanvas');
        // mousemove first (sets mouseX/mouseY in app.js before mousedown is processed)
        window.dispatchEvent(new MouseEvent('mousemove', {
            clientX: pos.x, clientY: pos.y, bubbles: true, cancelable: true
        }));
        mc.dispatchEvent(new MouseEvent('mousedown', {
            clientX: pos.x, clientY: pos.y,
            button: 0, buttons: 1, bubbles: true, cancelable: true
        }));
    }

    // Update the sim mouse position while dragging (leftMousePressed stays true in sim)
    function injectSimMove(clientX, clientY) {
        var uv = getHitUV(clientX, clientY);
        if (!uv) return;
        var pos = uvToCanvasPos(uv);
        window.dispatchEvent(new MouseEvent('mousemove', {
            clientX: pos.x, clientY: pos.y, bubbles: true, cancelable: true
        }));
    }

    // Release the sim mouse button
    function injectSimUp() {
        window.dispatchEvent(new MouseEvent('mouseup', {
            button: 0, buttons: 0, bubbles: true, cancelable: true
        }));
    }

    // ─── View toggling ─────────────────────────────────────────────────────────
    function enterGlobeMode() {
        if (!scene) {
            console.warn('[globe.js] Three.js not available — cannot enter globe mode');
            return;
        }
        var mc = document.getElementById('mainCanvas');
        if (!mc || mc.style.display !== 'block') {
            // Simulation hasn't started yet
            return;
        }

        isGlobeActive = true;

        var gc = document.getElementById('globeCanvas');
        if (gc) gc.style.display = 'block';

        // Resize renderer to current window (may have changed since init)
        onWindowResize();

        // Reset to a nice equatorial view
        sphericalPhi   = Math.PI / 2;
        sphericalTheta = 0;
        autoRotate     = true;
        lastInteraction = 0;

        syncToggleButton(true);
    }

    function enterMapMode() {
        isGlobeActive = false;
        var gc = document.getElementById('globeCanvas');
        if (gc) gc.style.display = 'none';
        syncToggleButton(false);
    }

    function toggleView() {
        if (isGlobeActive) {
            enterMapMode();
        } else {
            enterGlobeMode();
        }
    }

    function syncToggleButton(globeOn) {
        var btn = document.getElementById('gp-globe-toggle');
        if (!btn) return;
        btn.textContent = globeOn ? '\u{1F5FA} 2D Map' : '\u{1F30D} Globe View';
        btn.classList.toggle('active', globeOn);
    }

    // ─── Public API ────────────────────────────────────────────────────────────
    window.globeToggleView = toggleView;
    window.globeEnterGlobe = enterGlobeMode;
    window.globeEnterMap   = enterMapMode;

    // Boot once DOM is ready (Three.js CDN script must appear before globe.js)
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
