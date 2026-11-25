import 'reflect-metadata';
import assert from 'node:assert/strict';
import { DynamicModule, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { engine } from 'express-handlebars';
import { join } from 'node:path';
import test from 'node:test';
import {
  BuscarTareas, CargarPdf, ConsultarTrabajo, ConsultarUltimaBusqueda, ListarTareas,
  MAX_PDF_BYTES, SolicitarEntrega, VerTarea,
} from '../../core/application/tasks';
import { ApplicationError, JobView, TaskView } from '../../core/domain/model';
import { PanelModule } from './panel.module';

const identifiers = {
  task: '0ecd25cb-61f5-49a7-83b9-bdb97e5afdb0',
  datedTask: 'ad5b89bd-6ce4-4214-b479-c0e59114ca29',
  search: '9a23e3ed-1bc8-4c3c-81c9-f8880a116477',
  oldPdf: 'ed535c26-fede-4262-87af-6954cf69d7fb',
  pdf: 'c675f0c7-98b5-4403-a815-d2ee12e8cd14',
  delivery: '150dd89c-9ba6-4ee4-a665-d5230b72a85d',
};

@Module({})
class TestCore {}

test('panel MVC usa los casos de uso y respeta la autorización y los errores del PDF', async (suite) => {
  const accountId = 'alumno';
  const task: TaskView = {
    taskId: identifiers.task, externalId: '15', course: 'Programación', title: 'Informe de prueba', deadline: null,
    activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=15', destination: 'aula_virtual',
    currentPdf: null, delivery: null,
  };
  const dated: TaskView = { ...task, taskId: identifiers.datedTask, title: 'Informe con plazo', deadline: '2026-11-25' };
  let search: Extract<JobView, { kind: 'search' }> | null = null;
  const orders: string[] = [];
  let acceptedUploads = 0;
  const providers = [
    { provide: BuscarTareas, useValue: { async execute(account: string) {
      assert.equal(account, accountId);
      search = { kind: 'search', jobId: identifiers.search, state: 'queued', summary: null };
      return { jobId: identifiers.search };
    } } },
    { provide: ListarTareas, useValue: { async execute() { return [dated, task]; } } },
    { provide: VerTarea, useValue: { async execute(account: string, id: string) {
      assert.equal(account, accountId);
      if (id !== task.taskId) throw new ApplicationError('not_found', 'La tarea no existe.');
      return task;
    } } },
    { provide: ConsultarTrabajo, useValue: { async execute(_account: string, id: string) {
      const job = [search, task.delivery].find((candidate) => candidate?.jobId === id);
      if (!job) throw new ApplicationError('not_found', 'El trabajo no existe.');
      return job;
    } } },
    { provide: ConsultarUltimaBusqueda, useValue: { async execute() { return search; } } },
    { provide: CargarPdf, useValue: { async execute(input: { accountId: string; taskId: string; originalName: string; content: Buffer }) {
      assert.equal(input.accountId, accountId);
      assert.equal(input.taskId, task.taskId);
      if (!input.content.toString('ascii').startsWith('%PDF-')) throw new ApplicationError('invalid_pdf', 'El archivo no es válido.');
      acceptedUploads++;
      task.currentPdf = { pdfId: identifiers.pdf, originalName: input.originalName, sha256: 'test' };
      return task.currentPdf;
    } } },
    { provide: SolicitarEntrega, useValue: { async execute(input: { accountId: string; taskId: string; pdfId: string }) {
      assert.deepEqual([input.accountId, input.taskId], [accountId, task.taskId]);
      if (input.pdfId !== task.currentPdf?.pdfId) throw new ApplicationError('stale_pdf', 'Revisa el PDF vigente.');
      orders.push(input.pdfId);
      task.delivery ??= { kind: 'delivery', jobId: identifiers.delivery, state: 'authorized', summary: null, evidence: null };
      return { jobId: task.delivery.jobId };
    } } },
  ];
  const core: DynamicModule = { module: TestCore, providers, exports: providers.map(({ provide }) => provide) };
  @Module({ imports: [PanelModule.register(core, accountId, false)] })
  class TestApplication {}

  const app = await NestFactory.create<NestExpressApplication>(TestApplication, { logger: false });
  suite.after(() => app.close());
  app.engine('hbs', engine({ extname: '.hbs', defaultLayout: false }));
  app.setViewEngine('hbs');
  app.setBaseViewsDir(join(__dirname, 'views'));
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const path = '/tareas/' + task.taskId;
  const post = (route: string, body?: FormData | URLSearchParams, headers?: Record<string, string>) =>
    fetch(base + route, { method: 'POST', redirect: 'manual', body, headers });
  const read = async (route: string) => {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    return response.text();
  };

  const initial = await read('/');
  assert.ok(initial.indexOf('Informe con plazo') < initial.indexOf('Sin fecha'));
  assert.match(initial, /Sin fecha[\s\S]*Informe de prueba/);
  const rejected = await post('/busquedas', undefined, { Origin: 'https://otro.example', 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(rejected.status, 403);
  const started = await post('/busquedas');
  assert.equal(started.status, 303);
  assert.equal(started.headers.get('location'), '/?job=' + identifiers.search);
  assert.match(await read('/'), /data-job-id=/);
  const job = await fetch(base + '/trabajos/' + identifiers.search);
  assert.equal((await job.json()).state, 'queued');

  assert.match(await read(path), /Carga un PDF para habilitar la entrega/);
  const valid = new FormData();
  valid.set('pdf', new Blob(['%PDF-1.4\n%%EOF\n']), 'informe.pdf');
  assert.equal((await post(path + '/pdf', valid)).status, 303);
  assert.match(await read(path), new RegExp('name="pdfId" value="' + identifiers.pdf + '"'));
  const invalid = new FormData();
  invalid.set('pdf', new Blob(['contenido inválido']), 'informe.pdf');
  const invalidResponse = await post(path + '/pdf', invalid);
  assert.equal(invalidResponse.status, 400);
  assert.match(await invalidResponse.text(), /PDF vigente[\s\S]*informe.pdf[\s\S]*El archivo no es válido/);
  const large = new FormData();
  large.set('pdf', new Blob([new Uint8Array(MAX_PDF_BYTES + 1)]), 'grande.pdf');
  const largeResponse = await post(path + '/pdf', large);
  assert.equal(largeResponse.status, 413, await largeResponse.clone().text());
  assert.match(await largeResponse.text(), /PDF vigente[\s\S]*informe.pdf[\s\S]*supera el límite/);
  assert.equal(acceptedUploads, 1);

  task.destination = 'other';
  assert.match(await read(path), /canal de entrega externo/);
  assert.doesNotMatch(await read(path), /name="pdfId"/);
  task.destination = 'aula_virtual';

  const stale = await post(path + '/entregas', new URLSearchParams({ pdfId: identifiers.oldPdf }));
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), new RegExp('Revisa el PDF vigente[\\s\\S]*' + identifiers.pdf));

  const order = new URLSearchParams({ pdfId: identifiers.pdf });
  const duplicate = await Promise.all([post(path + '/entregas', order), post(path + '/entregas', order)]);
  assert.deepEqual(duplicate.map(({ status }) => status), [303, 303]);
  assert.deepEqual(orders, [identifiers.pdf, identifiers.pdf]);
  assert.match(await read(path), /Hay un intento de entrega en curso/);
  assert.ok(task.delivery);
  task.delivery.state = 'needs_verification';
  assert.match(await read(path), /El resultado está por verificar/);
  assert.doesNotMatch(await read(path), /name="pdfId"/);
  task.delivery.state = 'confirmed';
  task.delivery.pdfId = identifiers.pdf;
  assert.match(await read(path), /Este PDF ya está entregado/);
  task.currentPdf = { pdfId: identifiers.oldPdf, originalName: 'informe.pdf', sha256: 'test' };
  assert.match(await read(path), new RegExp('name="pdfId" value="' + identifiers.oldPdf + '"'));
});
