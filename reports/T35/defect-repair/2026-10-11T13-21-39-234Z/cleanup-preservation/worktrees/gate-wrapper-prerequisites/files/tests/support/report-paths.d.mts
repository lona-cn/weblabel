export const projectRoot: string;
export function projectOutputPath(candidate: string): string;
export function ownedReportRoot(candidate: string): string;
export function taskReportPath(taskId: string, ...segments: string[]): string;
