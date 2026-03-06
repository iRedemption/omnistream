// ── Sidebar Section Collapsibility ────────────────────────
// This module handles the collapsing logic for sidebar sections
// and persists their state in localStorage.

const STORAGE_KEY = 'sidebar_sections_state';

/**
 * Initialize collapsible sidebar sections.
 * Loads state from localStorage and attaches click listeners.
 */
export function initSidebarCollapsibility() {
    const sections = document.querySelectorAll('.sidebar-section');
    const savedState = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

    sections.forEach(section => {
        const id = section.dataset.sectionId;
        if (!id) return;

        const header = section.querySelector('.sidebar-section-header');

        // Default to collapsed (true) if no saved state exists
        const isCollapsed = savedState[id] !== undefined ? savedState[id] : true;

        if (isCollapsed) {
            section.classList.add('collapsed');
        } else {
            section.classList.remove('collapsed');
        }

        if (header) {
            header.addEventListener('click', (e) => {
                // Don't toggle if a button, input, or interactive element inside the header was clicked
                if (e.target.closest('button') ||
                    e.target.closest('input') ||
                    e.target.closest('select') ||
                    e.target.closest('.toggle-group')) {
                    return;
                }

                const nowCollapsed = section.classList.toggle('collapsed');
                updateSectionState(id, nowCollapsed);
            });
        }
    });
}

/**
 * Updates the persisted state for a specific section.
 * @param {string} id 
 * @param {boolean} isCollapsed 
 */
function updateSectionState(id, isCollapsed) {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    state[id] = isCollapsed;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
