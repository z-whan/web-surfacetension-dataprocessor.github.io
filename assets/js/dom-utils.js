(function () {
  function qs(selector, root) {
    return (root || document).querySelector(selector);
  }

  function clear(element) {
    if (!element) {
      return;
    }
    while (element.firstChild) {
      element.removeChild(element.firstChild);
    }
  }

  function setText(element, value) {
    if (element) {
      element.textContent = value == null ? "" : String(value);
    }
  }

  function setAttributes(element, attributes) {
    Object.keys(attributes || {}).forEach((name) => {
      const value = attributes[name];
      if (value === false || value === null || typeof value === "undefined") {
        return;
      }
      if (value === true) {
        element.setAttribute(name, "");
      } else {
        element.setAttribute(name, String(value));
      }
    });
  }

  function el(tagName, options, children) {
    const element = document.createElement(tagName);
    const opts = options || {};
    if (opts.className) {
      element.className = opts.className;
    }
    if (Object.prototype.hasOwnProperty.call(opts, "text")) {
      setText(element, opts.text);
    }
    if (opts.attrs) {
      setAttributes(element, opts.attrs);
    }
    if (opts.props) {
      Object.keys(opts.props).forEach((name) => {
        element[name] = opts.props[name];
      });
    }
    appendChildren(element, children || []);
    return element;
  }

  function appendChildren(parent, children) {
    (Array.isArray(children) ? children : [children]).forEach((child) => {
      if (child === null || typeof child === "undefined") {
        return;
      }
      parent.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child))
      );
    });
  }

  function replaceChildren(parent, children) {
    clear(parent);
    appendChildren(parent, children || []);
  }

  function populateSelect(select, items) {
    clear(select);
    items.forEach((item) => {
      const option = el("option", {
        text: item.label,
        attrs: { value: item.value },
        props: { selected: Boolean(item.selected) },
      });
      select.appendChild(option);
    });
  }

  function metricCard(label, value) {
    return el("div", { className: "metric-card" }, [
      el("span", { text: label }),
      el("strong", { text: value }),
    ]);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  window.SurfaceLabDomUtils = {
    qs,
    clear,
    setText,
    el,
    appendChildren,
    replaceChildren,
    populateSelect,
    metricCard,
    escapeHtml,
  };
})();
