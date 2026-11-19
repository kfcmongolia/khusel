(function(global, factory) {
  if (window.FORM_MODE === 'cardform') return;
  typeof exports === "object" && typeof module !== "undefined"
    ? (module.exports = factory())
    : typeof define === "function" && define.amd
      ? define(factory)
      : ((global = global || self), (global.ErrorNavigation = factory()));
})(this, function() { 'use strict';
  var state = {
    section: null,
    current: -1,
    errors: [],
    scrollToBottomOnClose: true,
  };

  // Banner texts come from form owners and translations, so they are parsed in an
  // inert document and only their text reaches the page.
  function plainText(html) {
    var doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return doc.body.textContent || '';
  }

  // The required asterisk is a span inside the label; it is aria-hidden, but
  // textContent still includes it.
  function labelText(label) {
    var clone = label.cloneNode(true);
    var marks = clone.querySelectorAll('.form-required');
    for (var i = 0; i < marks.length; i += 1) {
      marks[i].parentNode.removeChild(marks[i]);
    }
    return clone.textContent || '';
  }

  function fieldName(line) {
    var label = line.querySelector('.form-label, legend');
    var text = label ? labelText(label) : '';
    if (!String(text).trim()) {
      var widget = line.querySelector('[data-component="widget-field"]');
      if (widget) {
        text = widget.getAttribute('aria-label') || '';
        if (!text) {
          var labelledBy = widget.getAttribute('aria-labelledby') || '';
          var labelId = labelledBy.split(/\s+/)[0];
          var labelFromId = labelId && document.getElementById(labelId);
          text = labelFromId ? labelText(labelFromId) : '';
        }
      }
    }
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function renderMessage(message) {
    if (!message) return;
    while (message.firstChild) {
      message.removeChild(message.firstChild);
    }

    if (state.errors.length <= 0) {
      message.appendChild(document.createTextNode(plainText(JotForm.texts.doneMessage)));
      return;
    }

    const text = plainText(state.errors.length === 1 ? JotForm.texts.oneError : JotForm.texts.multipleError);
    const countIndex = text.indexOf('{count}');
    if (countIndex === -1) {
      message.appendChild(document.createTextNode(text));
    } else {
      const count = document.createElement('strong');
      count.textContent = String(state.errors.length);
      message.appendChild(document.createTextNode(text.substring(0, countIndex)));
      message.appendChild(count);
      message.appendChild(document.createTextNode(text.substring(countIndex + '{count}'.length)));
    }

    const names = [];
    for (let i = 0; i < state.errors.length; i += 1) {
      const name = fieldName(state.errors[i]);
      if (name) {
        names.push(name);
      }
    }
    // Screen reader only: the banner is fixed to the top of the viewport with no
    // max height, so a visible list covers the form when many fields fail.
    if (names.length > 0) {
      const end = /[.?!:;]$/.test(names[names.length - 1]) ? '' : '.';
      const srOnly = document.createElement('span');
      srOnly.className = 'sr-only';
      srOnly.textContent = `${' ' + names.join(', ') + end}`;
      message.appendChild(srOnly);
    }
  }

  function createNavigation(section) {
    var container = document.createElement('div');
    container.classList.add('error-navigation-container');
    container.style.display = 'none';
    container.setAttribute('aria-hidden', 'true');
    // Focusable so validation can move the SR cursor to the summary (with See
    // Errors next to it) instead of leaving focus on Submit/Next.
    container.setAttribute('tabindex', '-1');

    var inner = document.createElement('div');
    inner.classList.add('error-navigation-inner');
    container.appendChild(inner);

    var message = document.createElement('span');
    message.classList.add('error-navigation-message');
    message.setAttribute("role", "alert");
    message.setAttribute("aria-live", "polite");
    inner.appendChild(message);

    var nextButton = document.createElement('button');
    nextButton.classList.add('error-navigation-next-button');
    nextButton.type = 'button';
    nextButton.innerText = JotForm.texts.seeErrorsButton;
    nextButton.addEventListener('click', focusToNextError);
    inner.appendChild(nextButton);

    var doneButton = document.createElement('button');
    doneButton.classList.add('error-navigation-done-button');
    doneButton.type = 'button';
    doneButton.innerText = JotForm.texts.doneButton;
    doneButton.style.display = 'none';
    doneButton.addEventListener('click', close);
    inner.appendChild(doneButton);

    section.insertBefore(container, section.firstChild);
    return container;
  }

  function destroyNavigation(section) {
    var nav = section.querySelector('.error-navigation-container');
    if (nav) {
      nav.remove();
    }
  }

  function getAdvancedSignatureFocusTarget(line) {
    var wrapper = line.querySelector('.formAdvancedSignatureWrapper');
    if (!wrapper) {
      return null;
    }

    var typeInput = wrapper.querySelector('input[type="text"]:not([disabled])');
    if (typeInput) {
      return typeInput;
    }

    var drawCanvas = wrapper.querySelector('canvas.signatureCanvas');
    if (drawCanvas && drawCanvas.getAttribute('aria-hidden') !== 'true' && drawCanvas.tabIndex >= 0) {
      return drawCanvas;
    }

    return null;
  }

  /**
   * Widget questions validate through a hidden proxy input that cannot take
   * focus. The operable control lives inside the widget iframe, as with
   * hCaptcha, so error navigation should target the frame instead.
   *
   * @param {HTMLElement} line - The errored `.form-line` for a widget question.
   * @returns {HTMLIFrameElement | null} The widget iframe to focus, or null.
   */
  function getWidgetFocusTarget(line) {
    const widgetFrame = line.querySelector('[data-component="widget-field"] iframe')
      || line.querySelector('iframe');

    return widgetFrame || null;
  }

  function scrollAndFocus(nextCurrent, line, field, nextButton) {
    state.current = nextCurrent;
    line.scrollIntoView({ behavior: 'smooth', block: 'center' });
    field.focus();
    // VoiceOver in Chrome does not follow focus from a widget iframe into the frame.
    const widgetMatch = field.tagName === 'IFRAME' && /^customFieldFrame_(\d+)$/.exec(field.id);
    if (widgetMatch && typeof JotForm.focusWidget === 'function') {
      JotForm.focusWidget(widgetMatch[1]);
    }
    nextButton.disabled = false;
  }

  function isNewErrorCount() {
    const domErrorCount = state.section
      ? state.section.querySelectorAll('.form-line.form-line-error').length
      : document.querySelectorAll('.form-all .form-line.form-line-error').length;
    const stateErrorCount = state.errors.length;
    return domErrorCount !== stateErrorCount;
  }

  function focusToNextError() {
    var nextButton = document.querySelector('.error-navigation-next-button');
    nextButton.disabled = true;

    // reset current index if error count has changed
    if (isNewErrorCount()) state.current = -1;

    var nextCurrent = (state.current + 1) % state.errors.length;
    var erroredLine = state.errors[nextCurrent];
    if (!erroredLine) {
      return;
    }
    var erroredField = erroredLine.querySelector('.form-validation-error');
    if (!erroredField) {
      return;
    }

    if(erroredField.type === 'hidden' && erroredLine.dataset.type === 'control_captcha') {
      var iframe = erroredLine.querySelector('iframe');
      if (iframe) {
        // Update erroredField to point to iframe if it's hCaptcha
        erroredField = iframe;
      }
    }

    if (erroredField.type === 'hidden' && erroredLine.dataset.type === 'control_widget') {
      const widgetFocusTarget = getWidgetFocusTarget(erroredLine);
      if (widgetFocusTarget) {
        erroredField = widgetFocusTarget;
      }
    }

    if(erroredField.type === 'hidden' && erroredLine.dataset.type === 'control_signature') {
      var advancedSignatureFocusTarget = getAdvancedSignatureFocusTarget(erroredLine);
      if (advancedSignatureFocusTarget) {
        erroredField = advancedSignatureFocusTarget;
      }
    }

    if(erroredLine.dataset.type === 'control_fileupload') {
      const hasFailedUpload = erroredField.querySelector('.qq-upload-fail');

      if(hasFailedUpload) {
        // Handle the case where there's a failed upload
        const deleteButton = hasFailedUpload.querySelector('.qq-upload-delete');
        if(deleteButton) {
          erroredField = deleteButton;
        }
      }
    }

    // The closed section collapse should be visible
    var parent = erroredLine.parentNode;
    var sectionCollapse = (parent && parent.hasClassName('form-section-closed')) ? parent.querySelector('li[data-type="control_collapse"] .form-collapse-table') : null;
    if (JotForm.doubleValidationFlag()) {
      var sections = document.querySelectorAll('ul.form-section:not([id^="section_"])');
      if (sections.length > 1) {
        var pagesIndex = parent.pagesIndex;
        if (pagesIndex === undefined && parent.parentNode) {
          pagesIndex = parent.parentNode.pagesIndex;
        }

        // Log when error navigation takes the user to a page they have not yet visited.
        // This is a potential cause for blank submissions or missing fields.
        if (Object.keys(JotForm.visitedPages || {}).length && pagesIndex && !JotForm.visitedPages[pagesIndex]) {
          if (!JotForm.errorNavigationMessages) JotForm.errorNavigationMessages = [];

          const allSections = Array.from(document.querySelectorAll('.page-section'));
          const currentPageIndex = allSections.indexOf(JotForm.currentSection) + 1;
          const errorMessageEl = erroredLine.querySelector('.form-error-message');
          const errorMessage = errorMessageEl ? errorMessageEl.innerText.trim() : '';

          if (JotForm.errorNavigationMessages.indexOf(errorMessage) === -1) {
            JotForm.errorCatcherLog({ message: {
              targetInput: erroredField.id || erroredField.className,
              targetInputPageIndex: pagesIndex,
              currentPageIndex: currentPageIndex,
              visitedPages: JotForm.visitedPages,
              message: errorMessage,
              stack: (new Error()).stack
            }}, 'ERROR_NAVIGATION_FOR_NON_VISITED_PAGE');

            JotForm.errorNavigationMessages.push(errorMessage);
          }
        }

        JotForm.jumpToPage(pagesIndex, true);
      }
    }
    if (sectionCollapse) {
      sectionCollapse.click();
      var collapseInterval = setInterval(function() {
        if (!parent.hasClassName('form-section-closed') || document.activeElement === erroredField) {
          clearInterval(collapseInterval);
        }
        scrollAndFocus(nextCurrent, erroredLine, erroredField, nextButton);
      }, 500);
    } else {
      scrollAndFocus(nextCurrent, erroredLine, erroredField, nextButton);
    }
  }

  function close() {
    if (state.scrollToBottomOnClose) {
      window.scrollTo({ left: 0, top: document.body.scrollHeight, behavior: 'smooth' });
    }

    var bottomInterval = setInterval(function() {
      if (!state.scrollToBottomOnClose || (window.innerHeight + window.scrollY) >= document.body.offsetHeight) {
        clearInterval(bottomInterval);
        var errCont = state.section.querySelector('.error-navigation-container');
        if (errCont) {
            errCont.classList.add('fading-out');
        }
        setTimeout(function(){
          destroyNavigation(state.section);
        }, 210);
      }
    }, 100);
  }

  // FormTranslation dispatches `translationLoad` after JotForm.texts and the field
  // labels are translated, so rebuild the visible banner message from them
  // instead of relying on a reverse lookup of the already rendered HTML.
  document.addEventListener('translationLoad', function() {
    if (!state.section) {
      return;
    }
    var nav = state.section.querySelector('.error-navigation-container');
    var message = nav && nav.querySelector('.error-navigation-message');
    renderMessage(message);
  });

  return {
    disableScrollToBottom: function disableScrollToBottom() {
      state.scrollToBottomOnClose = false;
    },
    update: function update(section, render, focusSummary) {
      if (!section) {
        var sections = document.querySelectorAll('.form-section.page-section');
        if (sections.length <= 0) {
          return;
        }
        section = sections[(sections.length - 1)];
      }
      if (JotForm.doubleValidationFlag()) {
        state.section = document.querySelector('.form-all');
      } else {
        state.section = section;
      }

      var invalidFields = state.section.querySelectorAll('.form-line.form-line-error');

      if (invalidFields.length <= 0 && state.errors.length <= 0) {
        destroyNavigation(state.section);
        return;
      }

      // reset current index if error count has changed
      if (isNewErrorCount()) state.current = -1;

      state.errors = invalidFields;

      var nav = state.section.querySelector('.error-navigation-container');
      if (!nav) {
        if (!render) {
          return;
        }
        nav = createNavigation(state.section);
      }

      if (state.errors.length > 0) {
        nav.querySelector('.error-navigation-next-button').style.display = 'block';
        nav.querySelector('.error-navigation-done-button').style.display = 'none';
        nav.classList.remove('is-success');
      } else {
        nav.classList.add('is-success');
        nav.querySelector('.error-navigation-next-button').style.display = 'none';
        nav.querySelector('.error-navigation-done-button').style.display = 'block';
      }

      renderMessage(nav.querySelector('.error-navigation-message'));

      // show navigation
      nav.style.display = null;
      nav.setAttribute('aria-hidden', 'false');
      nav.classList.remove('fading-out');

      // Field blur and correction also call update(), so the banner can announce
      // through role=alert without pulling focus off the field. Next and Submit
      // pass focusSummary so the summary receives focus even when it is already
      // on screen.
      if (focusSummary && state.errors.length > 0 && typeof nav.focus === 'function') {
        nav.focus();
      }
    },
  };
});
