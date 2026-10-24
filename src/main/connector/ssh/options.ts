import { getControlPath, getKnownHostsPath } from '../../ssh-control';

/** Shared by terminal, exec, file transfer and non-PTY processes. */
export function sshConnectionOptions(
  host: string, port: number, user: string, multiplex: boolean, fileTransfer = false,
): string[] {
  return [
    ...(multiplex ? [
      '-o', 'ControlMaster=auto',
      '-o', `ControlPath=${getControlPath(host, port, user)}`,
      '-o', 'ControlPersist=600',
    ] : []),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile="${getKnownHostsPath()}"`,
    fileTransfer ? '-P' : '-p', String(port),
  ];
}
