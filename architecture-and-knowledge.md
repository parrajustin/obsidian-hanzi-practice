# Chinese Character Rendering and Quiz Engine: Complete Replication Blueprint

This document is a deeply technical, low-level engineering blueprint. It provides the **exact logic, object schemas, and mathematical algorithms** required to replicate a state-driven Chinese character calligraphy rendering and quiz grading system from scratch, without relying on any external source code.

---

## 1. Core Data Sourcing & Pipeline
To draw characters, you need coordinate data. This system relies on the open-source **Make Me a Hanzi** data format.

### 1.1 The JSON Schema
For every character, you must load a JSON file with the following schema:
- `strokes`: An array of SVG path data strings (`"M..."`), one for each stroke. The order in this array is the correct stroke order.
- `medians`: An array of arrays containing `[x, y]` coordinate pairs representing the median points (the skeleton/center-line) of each stroke.

### 1.2 Coordinate Normalization Engine
The raw data exists in a specific 1024x1024 bounding box where the Y-axis goes **UP** from `-124` to `900`.
To render this into an arbitrary user UI container (e.g., 500x500 pixels):
1. Calculate a uniform scale: `scale = Math.min(width - padding, height - padding) / 1024`.
2. Apply this scale to your rendering context via a transformation matrix: `matrix(scale, 0, 0, -scale, xOffset, yOffset)`.
3. **CRITICAL:** When capturing user touch/mouse events on the screen, standard screen Y-coordinates go *down*. You must run: `internalY = (containerHeight - yOffset - screenY) / scale` to invert the Y-axis and map the screen touch back to the 1024x1024 internal data space before you can grade the stroke.

---

## 2. Drawing Mechanics (The Clipping Trick)
Characters are drawn to simulate realistic calligraphy strokes using an SVG (or Canvas) clipping mask trick.

1. You use the SVG path string (`M 10 20 L...`) strictly as a **clipping mask** (`clipPath` in SVG, or `Path2D/clip()` in Canvas).
2. Inside this masked region, you generate a thick line using the `medians` coordinate array. This median line is drawn with a massive `stroke-width` (e.g., 200px) and `stroke-linecap="round"` so it completely overflows the clipping mask.
3. **Animation:** To animate the stroke being drawn, you animate the `stroke-dashoffset` of this thick median line from its full `getTotalLength()` down to 0. As the thick median line draws forward, the clipping mask restricts it perfectly to the shape of the calligraphy brush stroke.

---

## 3. The Animation Engine
The system does not animate DOM elements directly. It interpolates a plain JavaScript state object and triggers a re-render.

### 3.1 The State Tree Structure
Your central state object should look like this:
```json
{
  "options": { "highlightColor": "#FF0000" },
  "character": {
    "main": {
      "opacity": 1,
      "strokes": [
        { "opacity": 1, "displayPortion": 0.5 } 
      ]
    },
    "outline": { "opacity": 1, "strokes": [] },
    "highlight": { "opacity": 0, "strokes": [] }
  }
}
```
`displayPortion` (from 0 to 1) maps directly to the `stroke-dashoffset` proportion in the rendering step.

### 3.2 The Interpolator Loop
You must build a mutation class that animates specific state properties (e.g., `character.main.strokes.0.displayPortion`) over a set duration.
1. **The Loop:** Inside a `requestAnimationFrame` loop, calculate elapsed time.
2. **Raw Progress:** `progress = Math.min(1, elapsedTime / duration)`.
3. **Easing:** Apply an ease-in-out cosine function: `easedProgress = -Math.cos(progress * Math.PI) / 2 + 0.5`.
4. **Interpolation:** Recursively update the state object using linear interpolation for numbers: `currentValue = easedProgress * (endValue - startValue) + startValue`.
5. **Queue Manager:** If multiple animations are queued (e.g., drawing a character stroke by stroke), execute them sequentially. If a new animation targets the same state path as an active animation, the active one must be cancelled.

### 3.3 Orchestrating a Character Drawing Animation
To animate drawing an entire character, queue the following sequence:
1. Mutate the whole character `opacity` to `0` and all strokes' `displayPortion` to `1`.
2. Instantly set all strokes' `displayPortion` to `0` (preparing them to be drawn).
3. Mutate the whole character `opacity` to `1`.
4. For every stroke in the array:
   - Add a delay if it isn't the first stroke.
   - Mutate that specific stroke's `opacity` to `1`.
   - Mutate that specific stroke's `displayPortion` from `0` to `1` over `duration = (strokeLength + 600) / (3 * animationSpeed)`.

---

## 4. The Quiz State Machine
The quiz intercepts pointer events and validates them against the expected stroke logic.

**Logic Flow:**
1. **Init:** Set `currentStrokeIndex = 0`.
2. **Start Stroke:** On `mousedown/touchstart`, grab the coordinates, invert the Y-axis to internal coordinates, and begin tracking an array of points.
3. **Drag:** On `mousemove/touchmove`, continuously append internal `{x, y}` points to the array.
4. **End Stroke:** On `mouseup/touchend`, pass the user's point array and the expected stroke's median point array into the **Geometric Grading Math** (detailed below).
5. **Progression:**
   - **If Match:** Mutate the expected stroke's `displayPortion` to `1` (permanently revealing it) and increment `currentStrokeIndex++`.
   - **If Fail:** Increment a mistake counter. If mistakes exceed a threshold, rapidly highlight the correct stroke by animating its `displayPortion` in the `highlight` layer in and out over `(strokeLength + 600) / (3 * speed)`.

---

## 5. Deep Geometric Grading Math
This is the core algorithm pipeline for stroke validation. You must build a pipeline of exactly 6 mathematical checks. If a user stroke fails *any* of the first 5, it is rejected.

### Step 1: Average Distance Check (Proximity)
- **Logic:** Calculate the Euclidean distance from every point in the user's stroke to the closest point on the reference stroke. Average all these minimum distances.
- **Math:** `avgDist = sum(min(dist(userPoint, refPoint))) / numUserPoints`.
- **Threshold:** `avgDist <= 350 * distMod * leniency` (where `distMod` is 0.5 if it's an outline, otherwise 1).

### Step 2: Start and End Proximity
- **Logic:** Ensure the user started and stopped in the right general area.
- **Math:** `dist(userStart, refStart) <= 250 * leniency` AND `dist(userEnd, refEnd) <= 250 * leniency`.

### Step 3: Direction (Cosine Similarity)
- **Logic:** Ensure the stroke was drawn in the correct direction, not just scribbled randomly.
- **Algorithm:**
  1. Convert the user points into "edge vectors" by subtracting `point[n]` from `point[n-1]`. Do the same for the reference stroke.
  2. For every user edge vector, compute the Cosine Similarity against all reference vectors and keep the highest value.
  3. Average these highest values.
- **Math:** Cosine Similarity `(A · B) / (||A|| * ||B||)`.
- **Threshold:** The average maximum similarity must be strictly `> 0`.

### Step 4: Shape Fit (Discrete Fréchet Distance)
- **Logic:** Evaluates the geometric shape of the curve regardless of its scale or translation.
- **Algorithm:**
  1. **Procrustes Normalization:** 
     - Resample both curves to exactly 30 evenly spaced points (tracing the path). 
     - Find the centroid (mean X and Y) of the curve. Translate all points so the centroid is `(0,0)`. 
     - Scale both curves down by the root mean square (RMS) distance of their first and last points to the origin: `scale = sqrt( average( dist(first, origin)^2, dist(last, origin)^2 ) )`.
  2. **Fréchet Distance Calculation:** Implement Eiter and Mannila's (1994) dynamic programming algorithm to find the "leash length" required to walk the two curves.
     - Create a 2D matrix (`calcVal(i, j)`) where:
       `calcVal(i, j) = max( min(prevCol[j], prevCol[j-1], lastResult), distance(c1[i], c2[j]) )`.
  3. **Rotational Invariance:** Rotate the normalized reference curve by `[PI/16, PI/32, 0, -PI/32, -PI/16]` radians. Calculate the Fréchet distance for all 5 rotations and keep the minimum result.
- **Threshold:** `minFrechetDist <= 0.4 * leniency`.

### Step 5: Arc Length Validation
- **Logic:** Prevent tiny dots from passing as long strokes.
- **Math:** Sum the Euclidean distance between all consecutive points in both curves.
- **Threshold:** `(leniency * (userLen + 25)) / (refLen + 25) >= 0.35`.

### Step 6: The "Skipped Stroke" Edge Case
- **Logic:** If the user stroke passes steps 1-5 for the *current* stroke in the sequence, you must still check if the user accidentally skipped ahead and drew a future stroke instead.
- **Algorithm:** Run Step 1 (Average Distance) against all *future* strokes in the character. If it finds a future stroke with a smaller `avgDist` than the current stroke, it assumes the user drew out of order. 
- **Punishment:** Heavily punish the leniency: `leniencyAdjustment = (0.6 * (closestFutureDist + avgDist)) / (2 * avgDist)` and re-run Steps 1-5 against the *current* stroke. If it fails this stricter test, the stroke is rejected.
