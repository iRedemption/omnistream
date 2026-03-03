// ── Pure Layout Math ──────────────────────────────────────
// All functions here are stateless and receive their inputs
// as parameters. They return position/size data as plain
// objects — no DOM access, no imports from other modules.

/**
 * Find the optimal column count and cell dimensions that make
 * all `count` tiles fit inside a `W × H` container while
 * maintaining a 16:9 aspect ratio and `gapSize` gaps.
 *
 * @param {number} count   Number of stream tiles
 * @param {number} W       Container width  (px)
 * @param {number} H       Container height (px)
 * @param {number} gapSize Gap between tiles (px)
 * @returns {{ bestCols: number, bestRows: number, bestW: number, bestH: number }}
 */
export function findBestGrid(count, W, H, gapSize) {
    let bestW = 0, bestH = 0, bestCols = 1, bestRows = 1;

    for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const totalGapX = (cols + 1) * gapSize;
        const totalGapY = (rows + 1) * gapSize;

        let cellW = (W - totalGapX) / cols;
        let cellH = cellW / (16 / 9);

        if (cellH * rows + totalGapY > H) {
            cellH = (H - totalGapY) / rows;
            cellW = cellH * (16 / 9);
        }

        if (cellW > bestW) {
            bestW = cellW;
            bestH = cellH;
            bestCols = cols;
            bestRows = rows;
        }
    }

    return { bestCols, bestRows, bestW, bestH };
}

/**
 * Calculate the absolute pixel positions for all tiles in the
 * *normal* (no-focus) grid layout.
 *
 * @param {number}   count     Number of tiles
 * @param {number}   W         Container width  (px)
 * @param {number}   H         Container height (px)
 * @param {number}   gapSize   Gap between tiles (px)
 * @param {'left'|'center'|'right'} alignMode  Horizontal alignment of last row
 * @returns {Array<{x: number, y: number, w: number, h: number}>}  One entry per tile
 */
export function calcNormalLayout(count, W, H, gapSize, alignMode) {
    const { bestCols, bestRows, bestW, bestH } = findBestGrid(count, W, H, gapSize);

    const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
    const startY = (H - gridH) / 2;

    const positions = [];

    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / bestCols);
        const col = i % bestCols;

        const itemsInThisRow = Math.min(bestCols, count - row * bestCols);
        const rowWidth = itemsInThisRow * bestW + (itemsInThisRow - 1) * gapSize;

        let rowStartX;
        if (alignMode === 'left') {
            rowStartX = gapSize;
        } else if (alignMode === 'right') {
            rowStartX = W - rowWidth - gapSize;
        } else {
            rowStartX = (W - rowWidth) / 2;
        }

        positions.push({
            x: Math.floor(rowStartX + col * (bestW + gapSize)),
            y: Math.floor(startY + row * (bestH + gapSize)),
            w: Math.floor(bestW),
            h: Math.floor(bestH),
        });
    }

    return positions;
}

/**
 * Calculate the focus area and grid area rectangles for a
 * *focused* layout, given the current layout mode and grid
 * percentage.
 *
 * @param {number} W           Container width  (px)
 * @param {number} H           Container height (px)
 * @param {number} gapSize     Gap between tiles (px)
 * @param {'top'|'bottom'|'left'|'right'} layoutMode
 * @param {number} gridPercent Fraction (0–1) of available space for the grid strip
 * @returns {{ focusArea: {x,y,w,h}, gridArea: {x,y,w,h} }}
 */
export function calcFocusAreas(W, H, gapSize, layoutMode, gridPercent) {
    const availableW = W - 2 * gapSize;
    const availableH = H - 2 * gapSize;

    let focusArea = { x: 0, y: 0, w: 0, h: 0 };
    let gridArea = { x: 0, y: 0, w: 0, h: 0 };

    if (layoutMode === 'top') {
        gridArea.h = availableH * gridPercent;
        gridArea.w = availableW;
        gridArea.x = gapSize;
        gridArea.y = gapSize;

        focusArea.w = availableW;
        focusArea.h = availableH - gridArea.h - gapSize;
        focusArea.x = gapSize;
        focusArea.y = gapSize + gridArea.h + gapSize;

    } else if (layoutMode === 'bottom') {
        gridArea.h = availableH * gridPercent;
        gridArea.w = availableW;
        gridArea.x = gapSize;
        gridArea.y = H - gapSize - gridArea.h;

        focusArea.w = availableW;
        focusArea.h = availableH - gridArea.h - gapSize;
        focusArea.x = gapSize;
        focusArea.y = gapSize;

    } else if (layoutMode === 'left') {
        gridArea.w = availableW * gridPercent;
        gridArea.h = availableH;
        gridArea.x = gapSize;
        gridArea.y = gapSize;

        focusArea.w = availableW - gridArea.w - gapSize;
        focusArea.h = availableH;
        focusArea.x = gapSize + gridArea.w + gapSize;
        focusArea.y = gapSize;

    } else if (layoutMode === 'right') {
        gridArea.w = availableW * gridPercent;
        gridArea.h = availableH;
        gridArea.x = W - gapSize - gridArea.w;
        gridArea.y = gapSize;

        focusArea.w = availableW - gridArea.w - gapSize;
        focusArea.h = availableH;
        focusArea.x = gapSize;
        focusArea.y = gapSize;
    }

    return { focusArea, gridArea };
}

/**
 * Fit a 16:9 rectangle inside an area, centred.
 *
 * @param {{ x, y, w, h }} area  The bounding box
 * @returns {{ x, y, w, h }}     The fitted rectangle (floored)
 */
export function fitAspect(area) {
    let w = area.w;
    let h = w / (16 / 9);
    if (h > area.h) {
        h = area.h;
        w = h * (16 / 9);
    }
    return {
        x: Math.floor(area.x + (area.w - w) / 2),
        y: Math.floor(area.y + (area.h - h) / 2),
        w: Math.floor(w),
        h: Math.floor(h),
    };
}

/**
 * Calculate positions for smaller tiles within the grid area
 * of a focused layout.
 *
 * @param {number} count      Number of small-grid tiles
 * @param {{ x, y, w, h }} gridArea  The grid bounding box
 * @param {number} gapSize
 * @param {'left'|'center'|'right'} alignMode
 * @returns {Array<{x, y, w, h}>}
 */
export function calcFocusedGridTiles(count, gridArea, gapSize, alignMode) {
    const { bestCols, bestRows, bestW, bestH } = findBestGrid(count, gridArea.w, gridArea.h, gapSize);

    const gridH = bestRows * bestH + (bestRows - 1) * gapSize;
    const startY = gridArea.y + (gridArea.h - gridH) / 2;

    const positions = [];

    for (let i = 0; i < count; i++) {
        const row = Math.floor(i / bestCols);
        const col = i % bestCols;

        const itemsInThisRow = Math.min(bestCols, count - row * bestCols);
        const rowWidth = itemsInThisRow * bestW + (itemsInThisRow - 1) * gapSize;

        let rowStartX;
        if (alignMode === 'left') {
            rowStartX = gridArea.x;
        } else if (alignMode === 'right') {
            rowStartX = gridArea.x + gridArea.w - rowWidth;
        } else {
            rowStartX = gridArea.x + (gridArea.w - rowWidth) / 2;
        }

        positions.push({
            x: Math.floor(rowStartX + col * (bestW + gapSize)),
            y: Math.floor(startY + row * (bestH + gapSize)),
            w: Math.floor(bestW),
            h: Math.floor(bestH),
        });
    }

    return positions;
}
