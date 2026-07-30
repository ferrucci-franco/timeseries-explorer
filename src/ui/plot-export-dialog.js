import i18n from '../i18n/index.js';
import Modal from './modal.js';

/**
 * Export dialog behind the panel's download button.
 *
 * One place to leave a panel: the data as CSV (what the old CSV button did),
 * or the plot itself as a pixel image (PNG, with a quality multiplier) or a
 * vector image (SVG). Panels that show two charts — time series + spectrum,
 * histogram, heatmap, profile, correlation — let the user pick which one.
 *
 * Pure DOM: the caller passes the charts (already measured) and gets back the
 * chosen options, so nothing here knows about Plotly or the plot state.
 */

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';

const SCALES = [1, 2, 3, 4];
// The exported figure keeps the app's theme, or takes the one the document it
// is going into wants. Transparent belongs to a theme rather than replacing
// one: without dark text on it, a transparent figure is only half a decision.
const THEMES = ['current', 'light', 'dark', 'light-transparent'];

// Format, quality and theme survive between openings: producing the figures of
// one report means making the same three choices every time.
const remembered = { format: 'csv', scale: 2, theme: 'current' };

const IMAGE_FORMATS = new Set(['png', 'svg']);

// A file name typed by hand still has to be a file name: separators and the
// characters Windows rejects (<>:"/\|?*) become underscores, letters and
// digits of any language survive, and a leading dot would make a hidden file.
const sanitizeBaseName = (value) => String(value ?? '')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/^[._]+/, '')
    .slice(0, 120);

export default class PlotExportDialog {
    /**
     * @param {object} options
     * @param {string} [options.contextLabel] what the panel currently shows
     * @param {Array<{id: string, label: string, width: number, height: number}>} [options.charts]
     *   every Plotly chart in the panel, in display order
     * @param {string} [options.defaultChartId] chart preselected for images
     * @param {string} [options.csvBlockedReason] why this panel has no data
     *   table to export; the CSV option is then offered as disabled with this
     *   explanation rather than silently missing
     * @param {(format: string, chart: object|null) => string} [options.defaultBaseName]
     * @returns {Promise<null|{format: string, chartId: string, scale: number,
     *   theme: string, baseName: string, fileName: string}>}
     */
    static open({
        contextLabel = '',
        charts = [],
        defaultChartId = '',
        csvBlockedReason = '',
        defaultBaseName = () => 'export',
    } = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;

            const formats = [
                {
                    id: 'csv',
                    label: i18n.t('exportFormatCsv'),
                    hint: csvBlockedReason || i18n.t('exportFormatCsvHint'),
                    ext: 'csv',
                    disabled: !!csvBlockedReason,
                },
                // A panel whose chart has not been drawn has no image to give.
                { id: 'png', label: i18n.t('exportFormatPng'), hint: i18n.t('exportFormatPngHint'), ext: 'png', disabled: !charts.length },
                { id: 'svg', label: i18n.t('exportFormatSvg'), hint: i18n.t('exportFormatSvgHint'), ext: 'svg', disabled: !charts.length },
            ];

            const state = {
                format: csvBlockedReason && remembered.format === 'csv' ? 'png' : remembered.format,
                chartId: defaultChartId || charts[0]?.id || '',
                scale: SCALES.includes(remembered.scale) ? remembered.scale : 2,
                theme: THEMES.includes(remembered.theme) ? remembered.theme : 'current',
            };
            if (!charts.length) state.format = 'csv';

            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-plot-export';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');

            const content = document.createElement('div');
            content.className = 'modal-content';

            const icon = document.createElement('div');
            icon.className = 'modal-icon plot-export-icon';
            icon.innerHTML = DOWNLOAD_ICON;
            content.appendChild(icon);

            const title = document.createElement('div');
            title.className = 'modal-title';
            title.textContent = i18n.t('exportDialogTitle');
            content.appendChild(title);
            modal.setAttribute('aria-label', title.textContent);

            const message = document.createElement('div');
            message.className = 'modal-message';
            message.textContent = contextLabel
                ? `${i18n.t('exportDialogBody')} — ${contextLabel}`
                : i18n.t('exportDialogBody');
            content.appendChild(message);

            // ── Sections ───────────────────────────────────────────────────
            const makeSection = (titleText, className = '') => {
                const section = document.createElement('div');
                section.className = `export-section${className ? ` ${className}` : ''}`;
                const heading = document.createElement('div');
                heading.className = 'modal-section-title';
                heading.textContent = titleText;
                section.appendChild(heading);
                content.appendChild(section);
                return section;
            };

            const radioGroup = (name) => {
                const group = document.createElement('div');
                group.className = 'export-option-grid';
                group.setAttribute('role', 'radiogroup');
                group.dataset.group = name;
                return group;
            };

            const radioCard = (name, value, label, hint, { disabled = false } = {}) => {
                const row = document.createElement('label');
                row.className = 'export-option';
                if (disabled) row.classList.add('export-option-disabled');

                const input = document.createElement('input');
                input.type = 'radio';
                input.name = `omv-export-${name}`;
                input.value = value;
                input.disabled = disabled;
                row.appendChild(input);

                const text = document.createElement('div');
                text.className = 'export-option-text';
                const head = document.createElement('div');
                head.className = 'export-option-label';
                head.textContent = label;
                text.appendChild(head);
                if (hint) {
                    const note = document.createElement('div');
                    note.className = 'export-option-hint';
                    note.textContent = hint;
                    text.appendChild(note);
                }
                row.appendChild(text);
                return { row, input };
            };

            // Format
            const formatSection = makeSection(i18n.t('exportFormat'));
            const formatGroup = radioGroup('format');
            const formatInputs = formats.map((format) => {
                const { row, input } = radioCard('format', format.id, format.label, format.hint, { disabled: format.disabled });
                input.addEventListener('change', () => {
                    if (!input.checked) return;
                    state.format = format.id;
                    sync();
                });
                formatGroup.appendChild(row);
                return input;
            });
            formatSection.appendChild(formatGroup);

            // Which chart (only when the panel holds more than one)
            const chartSection = makeSection(i18n.t('exportChart'));
            const chartGroup = radioGroup('chart');
            chartGroup.classList.add('export-option-grid-compact');
            const chartInputs = charts.map((chart) => {
                const { row, input } = radioCard('chart', chart.id, chart.label, '');
                input.addEventListener('change', () => {
                    if (!input.checked) return;
                    state.chartId = chart.id;
                    sync();
                });
                chartGroup.appendChild(row);
                return input;
            });
            chartSection.appendChild(chartGroup);

            // Quality (PNG only)
            const qualitySection = makeSection(i18n.t('exportQuality'));
            const qualityRow = document.createElement('div');
            qualityRow.className = 'export-chip-row';
            qualityRow.setAttribute('role', 'radiogroup');
            const qualityInputs = SCALES.map((scale) => {
                const chip = document.createElement('label');
                chip.className = 'export-chip';
                const input = document.createElement('input');
                input.type = 'radio';
                input.name = 'omv-export-scale';
                input.value = String(scale);
                const span = document.createElement('span');
                span.textContent = `${scale}×`;
                chip.append(input, span);
                input.addEventListener('change', () => {
                    if (!input.checked) return;
                    state.scale = scale;
                    sync();
                });
                qualityRow.appendChild(chip);
                return input;
            });
            qualitySection.appendChild(qualityRow);
            const qualityHint = document.createElement('div');
            qualityHint.className = 'export-hint-line';
            qualitySection.appendChild(qualityHint);

            // Theme (images only)
            const themeSection = makeSection(i18n.t('exportTheme'));
            const themeGroup = radioGroup('theme');
            themeGroup.classList.add('export-option-grid-2col');
            const themeLabels = {
                current: i18n.t('exportThemeCurrent'),
                light: i18n.t('exportThemeLight'),
                dark: i18n.t('exportThemeDark'),
                'light-transparent': i18n.t('exportThemeLightTransparent'),
            };
            const themeInputs = THEMES.map((theme) => {
                const { row, input } = radioCard('theme', theme, themeLabels[theme], '');
                input.addEventListener('change', () => {
                    if (!input.checked) return;
                    state.theme = theme;
                    sync();
                });
                themeGroup.appendChild(row);
                return input;
            });
            themeSection.appendChild(themeGroup);

            // File name
            const nameSection = makeSection(i18n.t('exportFileName'), 'export-name-section');
            const nameRow = document.createElement('div');
            nameRow.className = 'export-name-row';
            const nameInput = document.createElement('input');
            nameInput.type = 'text';
            nameInput.className = 'export-name-input';
            nameInput.spellcheck = false;
            nameInput.setAttribute('aria-label', i18n.t('exportFileName'));
            const nameExt = document.createElement('span');
            nameExt.className = 'export-name-ext';
            nameRow.append(nameInput, nameExt);
            nameSection.appendChild(nameRow);

            let nameEdited = false;
            nameInput.addEventListener('input', () => { nameEdited = true; });

            // Buttons
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = i18n.t('cancel');
            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = i18n.t('exportAction');
            buttons.append(cancelBtn, confirmBtn);
            content.appendChild(buttons);

            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // ── Live state ─────────────────────────────────────────────────
            const currentChart = () => charts.find(chart => chart.id === state.chartId) || charts[0] || null;
            const currentFormat = () => formats.find(format => format.id === state.format) || formats[0];

            function sync() {
                const isImage = IMAGE_FORMATS.has(state.format);
                formatInputs.forEach((input, index) => { input.checked = formats[index].id === state.format; });
                chartInputs.forEach((input, index) => { input.checked = charts[index].id === state.chartId; });
                qualityInputs.forEach((input, index) => { input.checked = SCALES[index] === state.scale; });
                themeInputs.forEach((input, index) => { input.checked = THEMES[index] === state.theme; });

                // One chart means no choice to make; CSV covers the panel, not
                // a single pane, so the selector goes away there too.
                chartSection.hidden = !isImage || charts.length < 2;
                qualitySection.hidden = state.format !== 'png';
                themeSection.hidden = !isImage;

                const chart = currentChart();
                if (chart) {
                    const width = Math.max(1, Math.round(chart.width * state.scale));
                    const height = Math.max(1, Math.round(chart.height * state.scale));
                    qualityHint.textContent = i18n.t('exportQualityHint')
                        .replace('{w}', String(width))
                        .replace('{h}', String(height));
                }

                nameExt.textContent = `.${currentFormat().ext}`;
                if (!nameEdited) nameInput.value = defaultBaseName(state.format, isImage ? chart : null);
                confirmBtn.disabled = !!currentFormat().disabled;
            }

            sync();

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', keyHandler);
                Modal.close(overlay, previousActive);
                resolve(value);
            };

            const accept = () => {
                if (confirmBtn.disabled) return;
                const format = currentFormat();
                const baseName = sanitizeBaseName(nameInput.value) || sanitizeBaseName(defaultBaseName(state.format, currentChart())) || 'export';
                remembered.format = state.format;
                remembered.scale = state.scale;
                remembered.theme = state.theme;
                finish({
                    format: state.format,
                    chartId: state.chartId,
                    scale: state.scale,
                    theme: state.theme,
                    baseName,
                    fileName: `${baseName}.${format.ext}`,
                });
            };

            const keyHandler = (event) => {
                if (event.key === 'Escape') finish(null);
                // Enter from the name field is the natural "do it"; anywhere
                // else it would fight the radio groups' arrow-key navigation.
                else if (event.key === 'Enter' && event.target === nameInput) {
                    event.preventDefault();
                    accept();
                }
            };

            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', accept);
            overlay.addEventListener('click', (event) => {
                if (event.target === overlay) finish(null);
            });
            document.addEventListener('keydown', keyHandler);

            setTimeout(() => confirmBtn.focus(), 100);
            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    }
}
