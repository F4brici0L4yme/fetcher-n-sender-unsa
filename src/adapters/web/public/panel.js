(() => {
  const announce = (message) => {
    const liveRegion = document.querySelector('#panel-live-status');
    if (liveRegion) liveRegion.textContent = message;
  };

  // 1. Live SSE in-place updates for Agenda, Task Detail, Agent & Session views
  const mainPanel = document.querySelector('[data-capture-revision], [data-live-revision]');
  if (mainPanel) {
    let currentRevision = mainPanel.dataset.captureRevision ?? mainPanel.dataset.liveRevision ?? '';
    let pendingRevision = null;
    let refreshing = false;

    const isEditingForm = (container) => {
      const active = document.activeElement;
      if (!active) return false;
      if (container && !container.contains(active)) return false;
      const tag = active.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    };

    const hasPendingFileSelection = (container) => {
      if (!container) return false;
      const inputs = container.querySelectorAll('input[type="file"]');
      for (const input of inputs) {
        if (input instanceof HTMLInputElement && input.files && input.files.length > 0) {
          return true;
        }
      }
      return false;
    };

    async function refreshInPlace(nextRevision) {
      if (refreshing) {
        pendingRevision = nextRevision;
        return;
      }
      refreshing = true;
      try {
        const response = await fetch(window.location.href, {
          cache: 'no-store',
          headers: { 'X-Requested-With': 'panel-sse' },
        });
        if (!response.ok) return;
        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const incomingMain = doc.querySelector('[data-capture-revision], [data-live-revision]');

        const incomingContent = doc.querySelector('#panel-dynamic-content');
        const currentContent = document.querySelector('#panel-dynamic-content');
        if (incomingContent && currentContent && !isEditingForm(currentContent) && !hasPendingFileSelection(currentContent)) {
          currentContent.replaceWith(incomingContent);
        }

        const currentSession = document.querySelector('.session-card');
        const incomingSession = doc.querySelector('.session-card');
        if (incomingSession && currentSession && !isEditingForm(currentSession)) {
          currentSession.replaceWith(incomingSession);
        }

        const incomingSidebar = doc.querySelector('#sidebar-dynamic');
        const currentSidebar = document.querySelector('#sidebar-dynamic');
        if (incomingSidebar && currentSidebar) {
          currentSidebar.replaceWith(incomingSidebar);
        }

        // Sync hidden accountId & search button state on persistent forms outside #panel-dynamic-content.
        const incomingAccount = doc.querySelector('input[name="accountId"]')?.getAttribute('value');
        if (incomingAccount) {
          document.querySelectorAll('[data-command-card] input[name="accountId"], .policy-form input[name="accountId"], .header-search-form input[name="accountId"]')
            .forEach((el) => {
              if (el instanceof HTMLInputElement) el.value = incomingAccount;
            });
        }
        const incomingSearchBtn = doc.querySelector('.header-search-form button[type="submit"]');
        const currentSearchBtn = document.querySelector('.header-search-form button[type="submit"]');
        if (incomingSearchBtn instanceof HTMLButtonElement && currentSearchBtn instanceof HTMLButtonElement) {
          currentSearchBtn.disabled = incomingSearchBtn.disabled;
          if (incomingSearchBtn.hasAttribute('aria-busy')) currentSearchBtn.setAttribute('aria-busy', 'true');
          else currentSearchBtn.removeAttribute('aria-busy');
        }

        // Sync quick-command open task options without clearing user input.
        const incomingSelect = doc.querySelector('[data-command-select]');
        const currentSelect = document.querySelector('[data-command-select]');
        if (incomingSelect instanceof HTMLSelectElement && currentSelect instanceof HTMLSelectElement && document.activeElement !== currentSelect) {
          const previousValue = currentSelect.value;
          currentSelect.replaceChildren(...Array.from(incomingSelect.options).map((opt) => opt.cloneNode(true)));
          if (previousValue && Array.from(currentSelect.options).some((opt) => opt.value === previousValue)) {
            currentSelect.value = previousValue;
          }
        }

        const resolvedRevision = incomingMain?.dataset.captureRevision ?? incomingMain?.dataset.liveRevision ?? nextRevision;
        currentRevision = resolvedRevision;
        if (mainPanel.dataset.captureRevision !== undefined) {
          mainPanel.dataset.captureRevision = resolvedRevision;
        }
        if (mainPanel.dataset.liveRevision !== undefined) {
          mainPanel.dataset.liveRevision = resolvedRevision;
        }
        announce('Panel actualizado.');
      } catch {
        // Keep current DOM intact; EventSource reconnect or next revision will retry.
      } finally {
        refreshing = false;
        if (pendingRevision !== null && pendingRevision !== currentRevision) {
          const next = pendingRevision;
          pendingRevision = null;
          void refreshInPlace(next);
        } else {
          pendingRevision = null;
        }
      }
    }

    const changes = new EventSource('/eventos/tareas');
    changes.addEventListener('open', () => {
      const pill = document.querySelector('#sse-status-pill');
      if (pill) pill.classList.remove('is-reconnecting');
    });
    changes.addEventListener('error', () => {
      const pill = document.querySelector('#sse-status-pill');
      if (pill) pill.classList.add('is-reconnecting');
    });
    changes.addEventListener('tasks-version', (event) => {
      const { revision } = JSON.parse(event.data);
      const normalized = revision ?? '';
      if (normalized !== currentRevision) {
        void refreshInPlace(normalized);
      }
    });
  }

  // 2. Job polling fallback when SSE is not attached
  const jobStatus = document.querySelector('[data-job-id]');
  if (jobStatus && !mainPanel) {
    const url = '/trabajos/' + encodeURIComponent(jobStatus.dataset.jobId);
    const labelTarget = jobStatus.querySelector('p') ?? jobStatus;
    async function poll() {
      try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) throw new Error('No se pudo consultar el trabajo.');
        const job = await response.json();
        if (!job.active) {
          window.location.reload();
          return;
        }
        labelTarget.textContent = job.summary ? job.label + ' · ' + job.summary : job.label;
      } catch {
        labelTarget.textContent = 'No se pudo consultar el estado. Volviendo a intentar…';
      }
      window.setTimeout(poll, 1200);
    }
    window.setTimeout(poll, 800);
  }

  // 3. Interactive Quick-Command Analyzer (POST /api/agente/analizar)
  const commandCards = document.querySelectorAll('[data-command-card]');
  for (const card of commandCards) {
    const input = card.querySelector('[data-command-input]');
    const analyzeBtn = card.querySelector('[data-command-analyze]');
    const select = card.querySelector('[data-command-select]');
    const hiddenTaskId = card.querySelector('[data-command-task-id]');
    const preview = card.querySelector('[data-command-preview]');
    if (!(input instanceof HTMLInputElement) || !(preview instanceof HTMLElement)) continue;

    const setSelectedTaskId = (taskId) => {
      if (select instanceof HTMLSelectElement) select.value = taskId;
      if (hiddenTaskId instanceof HTMLInputElement) hiddenTaskId.value = taskId;
    };

    const showManualTaskPicker = async () => {
      try {
        const res = await fetch('/api/agente/tareas', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = await res.json();
        const openTasks = Array.isArray(payload.tasks)
          ? payload.tasks.filter((t) => t.destination === 'aula_virtual' && t.delivery?.state !== 'confirmed')
          : [];
        if (openTasks.length === 0) return;
        renderPreview({
          kind: 'ambiguous',
          pdfHint: null,
          candidates: openTasks.map((task) => ({ task })),
        });
      } catch {
        // Ignore transient network errors.
      }
    };

    const renderPreview = (data, preserveManualSelect = false) => {
      preview.replaceChildren();
      preview.hidden = false;

      const head = document.createElement('div');
      head.className = 'command-preview-head';

      const badge = document.createElement('span');
      if (data.kind === 'exact' && data.match?.task) {
        badge.className = 'badge badge--success';
        badge.textContent = 'Coincidencia exacta';
        head.appendChild(badge);

        const titleEl = document.createElement('strong');
        titleEl.textContent = `${data.match.task.title} · ${data.match.task.course}`;
        head.appendChild(titleEl);

        const changeBtn = document.createElement('button');
        changeBtn.type = 'button';
        changeBtn.className = 'btn btn-ghost btn-sm';
        changeBtn.textContent = 'Cambiar tarea';
        changeBtn.addEventListener('click', () => { void showManualTaskPicker(); });
        head.appendChild(changeBtn);

        preview.appendChild(head);
        setSelectedTaskId(data.match.task.taskId);

        const meta = document.createElement('p');
        meta.className = 'command-preview-meta';
        const parts = [];
        if (Array.isArray(data.match.reasons) && data.match.reasons.length > 0) {
          parts.push(`Detectado por: ${data.match.reasons.join(', ')}`);
        }
        if (data.pdfHint) {
          parts.push(`Archivo mencionado: ${data.pdfHint}`);
        }
        meta.textContent = parts.join(' · ') || 'Selecciona el PDF local y pulsa Autorizar y entregar.';
        preview.appendChild(meta);
        announce(`Coincidencia exacta: ${data.match.task.title}`);
        return;
      }

      if (data.kind === 'ambiguous' && Array.isArray(data.candidates) && data.candidates.length > 0) {
        if (!preserveManualSelect) setSelectedTaskId('');
        badge.className = 'badge badge--warning';
        badge.textContent = 'Elige la tarea destino';
        head.appendChild(badge);
        const msg = document.createElement('span');
        msg.textContent = 'Selecciona una tarea antes de autorizar:';
        head.appendChild(msg);
        preview.appendChild(head);

        const list = document.createElement('div');
        list.className = 'command-candidate-list';
        for (const candidate of data.candidates) {
          if (!candidate?.task) continue;
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn btn-secondary btn-sm';
          btn.textContent = `${candidate.task.course} — ${candidate.task.title}`;
          btn.addEventListener('click', () => {
            setSelectedTaskId(candidate.task.taskId);
            renderPreview({
              kind: 'exact',
              pdfHint: data.pdfHint,
              match: { task: candidate.task, reasons: ['selección manual'] },
            });
          });
          list.appendChild(btn);
        }
        preview.appendChild(list);
        announce('Varias tareas coinciden con tu instrucción. Elige una.');
        return;
      }

      if (!preserveManualSelect) setSelectedTaskId('');
      badge.className = 'badge badge--neutral';
      badge.textContent = 'Sin coincidencia automática';
      head.appendChild(badge);
      const hint = document.createElement('span');
      hint.textContent = 'No encontramos una tarea exacta para esa instrucción.';
      head.appendChild(hint);
      const manualBtn = document.createElement('button');
      manualBtn.type = 'button';
      manualBtn.className = 'btn btn-secondary btn-sm';
      manualBtn.textContent = 'Elegir tarea';
      manualBtn.addEventListener('click', () => { void showManualTaskPicker(); });
      head.appendChild(manualBtn);
      preview.appendChild(head);
    };

    const runAnalyze = async (fromBlur = false) => {
      const instruction = input.value.trim();
      if (!instruction) {
        preview.hidden = true;
        return;
      }
      if (analyzeBtn instanceof HTMLButtonElement) {
        analyzeBtn.setAttribute('aria-busy', 'true');
      }
      try {
        const res = await fetch('/api/agente/analizar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction }),
        });
        if (!res.ok) return;
        const data = await res.json();
        const hasManualSelect = select instanceof HTMLSelectElement && Boolean(select.value);
        renderPreview(data, fromBlur && hasManualSelect);
      } catch {
        // Keep form usable even if live preview request fails.
      } finally {
        if (analyzeBtn instanceof HTMLButtonElement) {
          analyzeBtn.removeAttribute('aria-busy');
        }
      }
    };

    const fallbackSelect = card.querySelector('[data-command-fallback-select]');
    if (fallbackSelect instanceof HTMLSelectElement) {
      setSelectedTaskId(fallbackSelect.value);
      fallbackSelect.addEventListener('change', () => setSelectedTaskId(fallbackSelect.value));
    }

    analyzeBtn?.addEventListener('click', () => { void runAnalyze(false); });
    input.addEventListener('blur', () => {
      if (input.value.trim().length >= 4) void runAnalyze(true);
    });
  }

  // 4. Accessible native <dialog> proof lightbox (delegated so it survives SSE swaps)
  const dialog = document.querySelector('#proof-lightbox');
  if (dialog instanceof HTMLDialogElement) {
    let lastFocused = null;
    const titleEl = dialog.querySelector('#proof-dialog-title');
    const metaEl = dialog.querySelector('[data-proof-meta-target]');
    const imgEl = dialog.querySelector('[data-proof-image]');
    const downloadEl = dialog.querySelector('[data-proof-download-link]');

    const closeLightbox = () => {
      if (dialog.open) dialog.close();
    };

    dialog.addEventListener('close', () => {
      if (lastFocused instanceof HTMLElement && document.contains(lastFocused)) {
        lastFocused.focus();
      }
      lastFocused = null;
    });

    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeLightbox();
    });

    document.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;

      const closeBtn = target.closest('[data-proof-close]');
      if (closeBtn) {
        closeLightbox();
        return;
      }

      const trigger = target.closest('[data-proof-open]');
      if (!(trigger instanceof HTMLElement)) return;
      const proofUrl = trigger.dataset.proofOpen;
      if (!proofUrl) return;
      lastFocused = trigger;

      if (titleEl) titleEl.textContent = trigger.dataset.proofTitle || 'Captura de entrega';
      if (metaEl) metaEl.textContent = trigger.dataset.proofMeta || '';
      if (imgEl instanceof HTMLImageElement) {
        imgEl.src = proofUrl;
        imgEl.alt = `Comprobante visual de DUTIC para ${trigger.dataset.proofTitle || 'entrega'}`;
      }
      if (downloadEl instanceof HTMLAnchorElement) {
        downloadEl.href = trigger.dataset.proofDownload || proofUrl;
      }

      dialog.showModal();
      const closeFocus = dialog.querySelector('[data-proof-close]');
      if (closeFocus instanceof HTMLElement) closeFocus.focus();
    });
  }

  // 5. Accessible roving-tabindex code tabs in /agente
  const tabContainers = document.querySelectorAll('[data-code-tabs]');
  for (const container of tabContainers) {
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const panels = Array.from(container.querySelectorAll('[role="tabpanel"]'));
    const copyBtn = container.querySelector('[data-code-copy]');
    if (tabs.length === 0) continue;

    const activate = (index, shouldFocus) => {
      tabs.forEach((tab, idx) => {
        const active = idx === index;
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        tab.tabIndex = active ? 0 : -1;
        tab.classList.toggle('is-active', active);
        const panelId = tab.getAttribute('aria-controls');
        const panel = panels.find((p) => p.id === panelId);
        if (panel instanceof HTMLElement) {
          panel.hidden = !active;
          if (active && copyBtn instanceof HTMLButtonElement) {
            copyBtn.dataset.copyText = panel.dataset.copySource ?? '';
          }
        }
      });
      if (shouldFocus && tabs[index] instanceof HTMLElement) {
        tabs[index].focus();
      }
    };

    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => activate(index, false));
      tab.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          activate((index + 1) % tabs.length, true);
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          activate((index - 1 + tabs.length) % tabs.length, true);
        } else if (event.key === 'Home') {
          event.preventDefault();
          activate(0, true);
        } else if (event.key === 'End') {
          event.preventDefault();
          activate(tabs.length - 1, true);
        }
      });
    });
  }

  // 6. Policy radio card active styling sync
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'radio' || input.name !== 'policy') return;
    const form = input.closest('.policy-form');
    if (!form) return;
    form.querySelectorAll('.policy-option').forEach((label) => {
      const radio = label.querySelector('input[type="radio"]');
      label.classList.toggle('is-selected', radio instanceof HTMLInputElement && radio.checked);
    });
  });

  // 7. Copy-to-clipboard buttons (delegated so they survive SSE swaps)
  document.addEventListener('click', async (event) => {
    const button = event.target instanceof Element ? event.target.closest('[data-copy-text]') : null;
    if (!(button instanceof HTMLButtonElement)) return;
    const text = button.dataset.copyText ?? '';
    if (!text) return;
    const labelSpan = button.querySelector('span') ?? button;
    const originalText = button.dataset.copyOriginal ?? labelSpan.textContent ?? 'Copiar';
    button.dataset.copyOriginal = originalText;

    try {
      await navigator.clipboard.writeText(text);
      labelSpan.textContent = button.dataset.copyDone ?? 'Copiada';
      button.classList.add('is-copied');
      announce('Texto copiado al portapapeles.');
      window.setTimeout(() => {
        labelSpan.textContent = originalText;
        button.classList.remove('is-copied');
      }, 2000);
    } catch {
      labelSpan.textContent = 'Selecciona y copia';
      window.setTimeout(() => {
        labelSpan.textContent = originalText;
      }, 2200);
    }
  });

  // 8. Mobile sidebar navigation drawer toggle
  const navToggle = document.querySelector('[data-nav-toggle]');
  const sidebar = document.querySelector('#workspace-sidebar');
  const backdrop = document.querySelector('[data-nav-backdrop]');
  if (navToggle instanceof HTMLButtonElement && sidebar instanceof HTMLElement) {
    const setOpen = (open, restoreFocus) => {
      sidebar.classList.toggle('is-open', open);
      navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (backdrop instanceof HTMLElement) {
        backdrop.hidden = !open;
      }
      if (!open && restoreFocus) {
        navToggle.focus();
      }
    };

    navToggle.addEventListener('click', () => {
      const next = navToggle.getAttribute('aria-expanded') !== 'true';
      setOpen(next, false);
    });

    if (backdrop instanceof HTMLElement) {
      backdrop.addEventListener('click', () => setOpen(false, true));
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && sidebar.classList.contains('is-open')) {
        setOpen(false, true);
      }
    });
  }

  // 9. Selected PDF filename & size feedback
  document.addEventListener('change', (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== 'file') return;
    const scope = input.closest('.file-chip-label') ?? input.closest('form');
    const label = scope?.querySelector('[data-file-label]');
    if (!(label instanceof HTMLElement)) return;
    const file = input.files?.[0];
    if (!file) {
      label.textContent = 'Ningún archivo nuevo seleccionado';
      return;
    }
    const sizeText = file.size >= 1024 * 1024
      ? `${(file.size / (1024 * 1024)).toFixed(2)} MiB`
      : `${Math.max(1, Math.round(file.size / 1024))} KiB`;
    label.textContent = `${file.name} · ${sizeText}`;
  });

  // 10. Progressive accessible segmented radiogroup for Priority & Status selects
  const selects = document.querySelectorAll('select[data-segmented-select]');
  for (const select of selects) {
    if (!(select instanceof HTMLSelectElement)) continue;
    const options = Array.from(select.options);
    if (options.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'segmented-radio-group';
    group.setAttribute('role', 'radiogroup');
    const labelId = select.dataset.labelId;
    if (labelId) {
      group.setAttribute('aria-labelledby', labelId);
    }

    const buttons = options.map((option) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segmented-radio-btn';
      btn.setAttribute('role', 'radio');
      btn.dataset.value = option.value;
      btn.textContent = option.textContent ?? option.value;
      const selected = option.value === select.value;
      btn.setAttribute('aria-checked', selected ? 'true' : 'false');
      btn.tabIndex = selected ? 0 : -1;
      group.appendChild(btn);
      return btn;
    });

    const selectIndex = (index, shouldFocus) => {
      const target = buttons[index];
      if (!target) return;
      select.value = target.dataset.value ?? '';
      buttons.forEach((btn, idx) => {
        const active = idx === index;
        btn.setAttribute('aria-checked', active ? 'true' : 'false');
        btn.tabIndex = active ? 0 : -1;
      });
      if (shouldFocus) target.focus();
    };

    buttons.forEach((btn, index) => {
      btn.addEventListener('click', () => selectIndex(index, false));
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
          event.preventDefault();
          selectIndex((index + 1) % buttons.length, true);
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
          event.preventDefault();
          selectIndex((index - 1 + buttons.length) % buttons.length, true);
        } else if (event.key === 'Home') {
          event.preventDefault();
          selectIndex(0, true);
        } else if (event.key === 'End') {
          event.preventDefault();
          selectIndex(buttons.length - 1, true);
        }
      });
    });

    select.hidden = true;
    select.insertAdjacentElement('afterend', group);

    if (labelId) {
      const labelEl = document.getElementById(labelId);
      if (labelEl) {
        labelEl.addEventListener('click', (event) => {
          event.preventDefault();
          const current = buttons.find((btn) => btn.getAttribute('aria-checked') === 'true') ?? buttons[0];
          current?.focus();
        });
      }
    }
  }
})();
