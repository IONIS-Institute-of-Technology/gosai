import { PROTOCOL_VERSION, type WelcomePayload } from '@gosai/shared/protocol';
import { SDK_VERSION } from './version.js';

/** The server speaks another version of the WebSocket protocol than this SDK. */
export class ProtocolVersionError extends Error {
  constructor(
    readonly serverProtocolVersion: number,
    readonly serverVersion: string,
  ) {
    super(
      `The GOSAI server ${serverVersion} speaks protocol version ${serverProtocolVersion}, ` +
        `but @gosai/sdk ${SDK_VERSION} speaks version ${PROTOCOL_VERSION}. ` +
        'Use the SDK that the server serves, or a GOSAI release made for this SDK.',
    );
    this.name = 'ProtocolVersionError';
  }
}

/** Throws a {@link ProtocolVersionError} when `welcome` names another protocol version. */
export function assertProtocolVersion(welcome: WelcomePayload): void {
  if (welcome.protocolVersion !== PROTOCOL_VERSION) {
    throw new ProtocolVersionError(welcome.protocolVersion, welcome.serverVersion);
  }
}
