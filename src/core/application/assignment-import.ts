import { CapturedAssignment } from '../domain/model';
import { AssignmentImportRepository } from './ports/persistence';

export class ImportarTareasObservadas {
  constructor(private readonly imports: AssignmentImportRepository) {}

  execute(accountId: string, assignments: CapturedAssignment[]) {
    return this.imports.recordImport(accountId, assignments);
  }
}

export class ConsultarRevisionTareas {
  constructor(private readonly imports: AssignmentImportRepository) {}

  execute(accountId: string) {
    return this.imports.latestCompletedSearchId(accountId);
  }
}
