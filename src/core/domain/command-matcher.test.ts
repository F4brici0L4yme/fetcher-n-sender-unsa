import assert from 'node:assert/strict';
import test from 'node:test';
import { TaskView } from './model';
import {
  extractPdfHint,
  LocalPdfEntry,
  matchLocalPdfFiles,
  matchTasksForCommand,
} from './command-matcher';

const sampleTasks: TaskView[] = [
  {
    taskId: '11111111-1111-4111-8111-111111111111',
    externalId: '101',
    course: 'Métodos Numéricos GB',
    title: 'Tarea 03 — Interpolación Polinomial',
    activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=101',
    deadline: '2026-12-01T04:59:00.000Z',
    destination: 'aula_virtual',
    currentPdf: null,
    delivery: null,
  },
  {
    taskId: '22222222-2222-4222-8222-222222222222',
    externalId: '102',
    course: 'Métodos Numéricos GB',
    title: 'Tarea 04 — Integración Numérica',
    activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=102',
    deadline: '2026-12-05T04:59:00.000Z',
    destination: 'aula_virtual',
    currentPdf: null,
    delivery: null,
  },
  {
    taskId: '33333333-3333-4333-8333-333333333333',
    externalId: '103',
    course: 'Ingeniería de Software II',
    title: 'Tarea 3 — Diagramas de Arquitectura',
    activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=103',
    deadline: '2026-12-03T04:59:00.000Z',
    destination: 'aula_virtual',
    currentPdf: null,
    delivery: null,
  },
  {
    taskId: '44444444-4444-4444-8444-444444444444',
    externalId: '104',
    course: 'Métodos Numéricos GB',
    title: 'Tarea 01 — Errores',
    activityUrl: 'https://aula.example.edu/mod/assign/view.php?id=104',
    deadline: '2026-11-30T04:59:00.000Z',
    destination: 'aula_virtual',
    currentPdf: { pdfId: 'pdf-1', originalName: 't1.pdf', sha256: 'a'.repeat(64) },
    delivery: { kind: 'delivery', jobId: 'job-1', state: 'confirmed', summary: 'Entrega confirmada.', evidence: null, pdfId: 'pdf-1' },
  },
];

test('extractPdfHint extracts exact PDF filename from natural Spanish instruction', () => {
  assert.equal(
    extractPdfHint('tengo mi pdf en la ruta home de mn llamano tareaMN.pdf subelo a la tarea 3 de mn'),
    'tareaMN.pdf',
  );
  assert.equal(
    extractPdfHint('sube ~/mn/laboratorio-04.pdf a la tarea 4'),
    'laboratorio-04.pdf',
  );
  assert.equal(extractPdfHint('subelo a la tarea 3 de mn'), null);
});

test('matchTasksForCommand resolves exact course acronym and task number', () => {
  const result = matchTasksForCommand(
    sampleTasks,
    'tengo mi pdf en la ruta home de mn llamano tareaMN.pdf subelo a la tarea 3 de mn',
  );
  assert.equal(result.kind, 'exact');
  assert.equal(result.match?.task.taskId, '11111111-1111-4111-8111-111111111111');
  assert.equal(result.pdfHint, 'tareaMN.pdf');
});

test('matchTasksForCommand returns ambiguous when multiple tasks match without course disambiguator', () => {
  const result = matchTasksForCommand(sampleTasks, 'sube mi informe.pdf a la tarea 3');
  assert.equal(result.kind, 'ambiguous');
  assert.ok(result.candidates.length >= 2);
  assert.equal(result.match, null);
});

test('matchTasksForCommand skips already confirmed tasks and external destinations', () => {
  const externalOnly: TaskView[] = [
    { ...sampleTasks[0]!, destination: 'other' },
    sampleTasks[3]!,
  ];
  const result = matchTasksForCommand(externalOnly, 'sube t1.pdf a la tarea 1 de mn');
  assert.equal(result.kind, 'none');
  assert.equal(result.candidates.length, 0);
});

test('matchTasksForCommand returns none for empty or unrelated instructions', () => {
  assert.equal(matchTasksForCommand(sampleTasks, '   ').kind, 'none');
  assert.equal(matchTasksForCommand(sampleTasks, 'sube fisica cuantica examen 99').kind, 'none');
});

test('matchTasksForCommand strips real UNSA DUTIC semester/faculty/code prefixes when matching acronyms', () => {
  const duticTasks: TaskView[] = [
    {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      externalId: '201',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Laboratorio 08 — Integración Numérica',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=201',
      deadline: '2026-12-08T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
      externalId: '202',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Laboratorio 07 — Derivación',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=202',
      deadline: '2026-12-01T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
      externalId: '203',
      course: '26B EPIS: INGENIERIA DE SOFTWARE II GA',
      title: 'Laboratorio 08 — Pruebas E2E',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=203',
      deadline: '2026-12-09T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4',
      externalId: '204',
      course: '1703244B UNSA ESCUELA SISTEMAS: SISTEMAS OPERATIVOS SEC A',
      title: 'Práctica 04 — Hilos',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=204',
      deadline: '2026-12-10T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];

  const mnResult = matchTasksForCommand(
    duticTasks,
    'subeme el laboratorio 8 de mn que esta en la ruta home/Student subelo al correspondiente',
  );
  assert.equal(mnResult.kind, 'exact');
  assert.equal(mnResult.match?.task.taskId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1');

  const isResult = matchTasksForCommand(duticTasks, 'sube lab 8 de is');
  assert.equal(isResult.kind, 'exact');
  assert.equal(isResult.match?.task.taskId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3');

  const soResult = matchTasksForCommand(duticTasks, 'sube prac 4 de so');
  assert.equal(soResult.kind, 'exact');
  assert.equal(soResult.match?.task.taskId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4');
});

test('matchTasksForCommand treats actividad/practica/laboratorio/tarea as compatible soft hints without overriding exact matches', () => {
  const practicaOnly: TaskView[] = [
    {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      externalId: '301',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Practica 08',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=301',
      deadline: '2026-12-08T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      externalId: '302',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Practica 07',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=302',
      deadline: '2026-12-01T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
    {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
      externalId: '303',
      course: '26B EPIS: INGENIERIA DE SOFTWARE II GA',
      title: 'Laboratorio 08',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=303',
      deadline: '2026-12-09T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];

  const softMatch = matchTasksForCommand(practicaOnly, 'subeme el laboratorio 8 de mn');
  assert.equal(softMatch.kind, 'exact');
  assert.equal(softMatch.match?.task.taskId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1');

  const bothLabAndPractica: TaskView[] = [
    ...practicaOnly,
    {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
      externalId: '304',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Laboratorio 08',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=304',
      deadline: '2026-12-08T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];

  const exactTypePreferred = matchTasksForCommand(bothLabAndPractica, 'sube el lab 8 de mn');
  assert.equal(exactTypePreferred.kind, 'exact');
  assert.equal(exactTypePreferred.match?.task.taskId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4');

  const twoSoftSynonyms: TaskView[] = [
    practicaOnly[0]!,
    {
      taskId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
      externalId: '305',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Actividad 08',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=305',
      deadline: '2026-12-08T04:59:00.000Z',
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];
  const ambiguousSoft = matchTasksForCommand(twoSoftSynonyms, 'subeme el laboratorio 8 de mn');
  assert.equal(ambiguousSoft.kind, 'ambiguous');
  assert.equal(ambiguousSoft.match, null);
  assert.equal(ambiguousSoft.candidates.length, 2);
});

test('matchLocalPdfFiles resolves exact filename hints, natural queries, folder acronyms, and bidirectional abbreviations', () => {
  const files: LocalPdfEntry[] = [
    {
      path: '/home/student/mn/Lab08.pdf',
      fileName: 'Lab08.pdf',
      relativePath: 'mn/Lab08.pdf',
      sizeBytes: 42000,
      modifiedAt: '2026-11-26T10:00:00.000Z',
    },
    {
      path: '/home/student/mn/Lab07.pdf',
      fileName: 'Lab07.pdf',
      relativePath: 'mn/Lab07.pdf',
      sizeBytes: 38000,
      modifiedAt: '2026-11-20T10:00:00.000Z',
    },
    {
      path: '/home/student/is/Lab08.pdf',
      fileName: 'Lab08.pdf',
      relativePath: 'is/Lab08.pdf',
      sizeBytes: 41000,
      modifiedAt: '2026-11-25T10:00:00.000Z',
    },
    {
      path: '/home/student/mn/tareaMN.pdf',
      fileName: 'tareaMN.pdf',
      relativePath: 'mn/tareaMN.pdf',
      sizeBytes: 51200,
      modifiedAt: '2026-11-24T10:00:00.000Z',
    },
  ];

  const naturalResult = matchLocalPdfFiles(
    files,
    'subeme el laboratorio 8 de mn que esta en la ruta home/Student subelo al correspondiente',
  );
  assert.equal(naturalResult.kind, 'exact');
  assert.equal(naturalResult.match?.file.relativePath, 'mn/Lab08.pdf');

  const exactFileHint = matchLocalPdfFiles(
    files,
    'tengo mi pdf en la ruta home de mn llamano tareaMN.pdf subelo a la tarea 3 de mn',
  );
  assert.equal(exactFileHint.kind, 'exact');
  assert.equal(exactFileHint.match?.file.relativePath, 'mn/tareaMN.pdf');

  const fullCourseNameQuery = matchLocalPdfFiles(files, 'sube el laboratorio 8 de metodos numericos');
  assert.equal(fullCourseNameQuery.kind, 'exact');
  assert.equal(fullCourseNameQuery.match?.file.relativePath, 'mn/Lab08.pdf');

  const acronymFolderFiles: LocalPdfEntry[] = [
    {
      path: '/home/student/Metodos Numericos/Practica_08.pdf',
      fileName: 'Practica_08.pdf',
      relativePath: 'Metodos Numericos/Practica_08.pdf',
      sizeBytes: 50000,
      modifiedAt: '2026-11-26T10:00:00.000Z',
    },
    {
      path: '/home/student/Ingenieria de Software/Practica_08.pdf',
      fileName: 'Practica_08.pdf',
      relativePath: 'Ingenieria de Software/Practica_08.pdf',
      sizeBytes: 50000,
      modifiedAt: '2026-11-26T09:00:00.000Z',
    },
  ];
  const folderAcronymResult = matchLocalPdfFiles(acronymFolderFiles, 'laboratorio 8 de mn');
  assert.equal(folderAcronymResult.kind, 'exact');
  assert.equal(folderAcronymResult.match?.file.relativePath, 'Metodos Numericos/Practica_08.pdf');
});

test('matchLocalPdfFiles returns ambiguous for close PDFs and none when nothing matches', () => {
  const closePdfs: LocalPdfEntry[] = [
    {
      path: '/home/student/mn/Lab08_borrador.pdf',
      fileName: 'Lab08_borrador.pdf',
      relativePath: 'mn/Lab08_borrador.pdf',
      sizeBytes: 40000,
      modifiedAt: '2026-11-26T09:00:00.000Z',
    },
    {
      path: '/home/student/mn/Lab08_final.pdf',
      fileName: 'Lab08_final.pdf',
      relativePath: 'mn/Lab08_final.pdf',
      sizeBytes: 42000,
      modifiedAt: '2026-11-26T10:00:00.000Z',
    },
  ];

  const ambiguous = matchLocalPdfFiles(closePdfs, 'subeme el laboratorio 8 de mn');
  assert.equal(ambiguous.kind, 'ambiguous');
  assert.equal(ambiguous.match, null);
  assert.equal(ambiguous.candidates.length, 2);

  const unrelated = matchLocalPdfFiles(closePdfs, 'subeme el examen 99 de fisica cuantica');
  assert.equal(unrelated.kind, 'none');
  assert.equal(unrelated.match, null);
  assert.equal(unrelated.candidates.length, 0);

  const wrongNumberOnly: LocalPdfEntry[] = [
    {
      path: '/home/student/mn/Lab07.pdf',
      fileName: 'Lab07.pdf',
      relativePath: 'mn/Lab07.pdf',
      sizeBytes: 38000,
      modifiedAt: '2026-11-20T10:00:00.000Z',
    },
  ];
  assert.equal(matchLocalPdfFiles(wrongNumberOnly, 'subeme el laboratorio 8 de mn').kind, 'none');

  assert.equal(matchLocalPdfFiles([], 'laboratorio 8 de mn').kind, 'none');
  assert.equal(matchLocalPdfFiles(closePdfs, '   ').kind, 'none');
});

test('matchLocalPdfFiles disambiguates duplicate filenames by folder and never auto-selects a different file when explicit pdfHint is missing', () => {
  const duplicateNames: LocalPdfEntry[] = [
    {
      path: '/home/student/mn/tareaMN.pdf',
      fileName: 'tareaMN.pdf',
      relativePath: 'mn/tareaMN.pdf',
      sizeBytes: 42000,
      modifiedAt: '2026-11-26T10:00:00.000Z',
    },
    {
      path: '/home/student/backup/tareaMN.pdf',
      fileName: 'tareaMN.pdf',
      relativePath: 'backup/tareaMN.pdf',
      sizeBytes: 42000,
      modifiedAt: '2026-11-25T10:00:00.000Z',
    },
  ];

  const byFolder = matchLocalPdfFiles(duplicateNames, 'sube tareaMN.pdf de mn');
  assert.equal(byFolder.kind, 'exact');
  assert.equal(byFolder.match?.file.relativePath, 'mn/tareaMN.pdf');

  const noFolderHint = matchLocalPdfFiles(duplicateNames, 'sube tareaMN.pdf');
  assert.equal(noFolderHint.kind, 'ambiguous');
  assert.equal(noFolderHint.match, null);

  const differentFile: LocalPdfEntry[] = [
    {
      path: '/home/student/mn/Lab08.pdf',
      fileName: 'Lab08.pdf',
      relativePath: 'mn/Lab08.pdf',
      sizeBytes: 42000,
      modifiedAt: '2026-11-26T10:00:00.000Z',
    },
  ];
  const missingExplicitPdf = matchLocalPdfFiles(differentFile, 'sube otro_archivo.pdf al laboratorio 8 de mn');
  assert.notEqual(missingExplicitPdf.kind, 'exact');
});

test('matchTasksForCommand and matchLocalPdfFiles never classify wrong-number or wrong-course candidates as exact', () => {
  // Probe 1: Wrong task number must never be 'exact' (prevents auto-submitting Lab 08 into Lab 07).
  const onlyLab7Task: TaskView[] = [
    {
      taskId: '11111111-1111-4111-8111-111111111111',
      externalId: '202',
      course: '26B SISTEMAS: METODOS NUMERICOS GB',
      title: 'Laboratorio 07 — Derivación',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=202',
      deadline: null,
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];
  const wrongTaskNumber = matchTasksForCommand(onlyLab7Task, 'subeme el laboratorio 8 de mn');
  assert.notEqual(wrongTaskNumber.kind, 'exact');
  assert.equal(wrongTaskNumber.match, null);

  // Wrong course task with matching number must never be 'exact'.
  const wrongCourseTask: TaskView[] = [
    {
      taskId: '22222222-2222-4222-8222-222222222222',
      externalId: '203',
      course: '26B EPIS: INGENIERIA DE SOFTWARE II GA',
      title: 'Laboratorio 08 — Pruebas E2E',
      activityUrl: 'https://aulavirtual.unsa.edu.pe/mod/assign/view.php?id=203',
      deadline: null,
      destination: 'aula_virtual',
      currentPdf: null,
      delivery: null,
    },
  ];
  const wrongTaskCourse = matchTasksForCommand(wrongCourseTask, 'subeme el laboratorio 8 de mn');
  assert.notEqual(wrongTaskCourse.kind, 'exact');
  assert.equal(wrongTaskCourse.match, null);

  // Probe 2: Wrong PDF number in matching course folder must never be 'exact'.
  const wrongPdfNumber = matchLocalPdfFiles(
    [
      {
        path: '/home/student/mn/laboratorio/Laboratorio07_MN.pdf',
        fileName: 'Laboratorio07_MN.pdf',
        relativePath: 'mn/laboratorio/Laboratorio07_MN.pdf',
        sizeBytes: 42000,
        modifiedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
    'subeme el laboratorio 8 de mn',
  );
  assert.notEqual(wrongPdfNumber.kind, 'exact');
  assert.equal(wrongPdfNumber.match, null);

  const wrongPdfNumberFullName = matchLocalPdfFiles(
    [
      {
        path: '/home/student/mn/Metodos_Numericos_Lab07.pdf',
        fileName: 'Metodos_Numericos_Lab07.pdf',
        relativePath: 'mn/Metodos_Numericos_Lab07.pdf',
        sizeBytes: 42000,
        modifiedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
    'laboratorio 8 de metodos numericos',
  );
  assert.notEqual(wrongPdfNumberFullName.kind, 'exact');
  assert.equal(wrongPdfNumberFullName.match, null);

  // Probe 3: Another course's PDF with matching number must never be 'exact' when query specifies course.
  const wrongCoursePdf = matchLocalPdfFiles(
    [
      {
        path: '/home/student/is/Lab08.pdf',
        fileName: 'Lab08.pdf',
        relativePath: 'is/Lab08.pdf',
        sizeBytes: 42000,
        modifiedAt: '2026-11-26T10:00:00.000Z',
      },
    ],
    'subeme el laboratorio 8 de mn que esta en la ruta home/Student',
  );
  assert.notEqual(wrongCoursePdf.kind, 'exact');
  assert.equal(wrongCoursePdf.match, null);
});
