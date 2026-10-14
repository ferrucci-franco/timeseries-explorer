// Small DOM builders shared by the phone layout's sheets (compact-methods.js
// and the pieces split out of it).

export function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

export function button(className, label, onClick, { icon = '', title = '' } = {}) {
    const btn = el('button', className);
    btn.type = 'button';
    if (icon) {
        const iconSpan = el('span', 'compact-btn-icon');
        iconSpan.innerHTML = icon;
        btn.appendChild(iconSpan);
    }
    if (label) btn.appendChild(el('span', 'compact-btn-label', label));
    if (title || !label) {
        btn.title = title || '';
        btn.setAttribute('aria-label', title || label || '');
    }
    btn.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return btn;
}

export function section(titleText) {
    const wrap = el('section', 'compact-section');
    if (titleText) wrap.appendChild(el('h3', 'compact-section-title', titleText));
    return wrap;
}
