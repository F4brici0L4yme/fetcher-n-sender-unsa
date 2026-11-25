const capturePanel = document.querySelector('[data-capture-revision]');
if (capturePanel) {
  const changes = new EventSource('/eventos/tareas');
  changes.addEventListener('tasks-version', (event) => {
    const { revision } = JSON.parse(event.data);
    if ((revision ?? '') !== capturePanel.dataset.captureRevision) {
      changes.close();
      window.location.reload();
    }
  });
}

const status = document.querySelector('[data-job-id]');
if (status && !capturePanel) {
  const url = '/trabajos/' + encodeURIComponent(status.dataset.jobId);
  async function poll() {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error('No se pudo consultar el trabajo.');
      const job = await response.json();
      if (!job.active) {
        window.location.reload();
        return;
      }
      status.textContent = job.summary ? job.label + ' · ' + job.summary : job.label;
    } catch {
      status.textContent = 'No se pudo consultar el estado. Volviendo a intentar…';
    }
    window.setTimeout(poll, 1200);
  }
  window.setTimeout(poll, 800);
}
