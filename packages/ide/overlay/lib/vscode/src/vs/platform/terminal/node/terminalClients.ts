import { TerminalDataFlowControl } from '../common/terminalDataFlowControl.js';

export interface IViewportDimensions {
	cols: number;
	rows: number;
	pixelWidth?: number;
	pixelHeight?: number;
}

interface ITerminalClient {
	viewport?: IViewportDimensions;
	/** Zero until the client asks for the terminal to be its size, then increasing. */
	activation: number;
}

/**
 * The clients of one pty, as far as the pty is concerned: which of them the
 * single size belongs to, and which of their acknowledgements advance the single
 * flow-control counter. Who holds the terminal and which client an event belongs
 * to is not decided here - that is the server channel's TerminalClientState,
 * which is also where these names come from.
 */
export class TerminalClients {
	private readonly _dataFlowControl: TerminalDataFlowControl;
	private readonly _clients = new Map<string, ITerminalClient>();
	private _activeClient: string | undefined;
	private _activations = 0;
	private _dimensions: IViewportDimensions;
	private readonly _resize: (dimensions: IViewportDimensions) => boolean;

	constructor(
		dimensions: IViewportDimensions,
		acknowledge: (charCount: number) => void,
		resize: (dimensions: IViewportDimensions) => boolean
	) {
		this._dimensions = dimensions;
		this._resize = resize;
		this._dataFlowControl = new TerminalDataFlowControl(acknowledge);
	}

	acceptData(length: number): void {
		this._dataFlowControl.acceptData(length);
	}

	acknowledge(clientId: string, charCount: number): void {
		this._dataFlowControl.acknowledge(clientId, charCount);
	}

	resetAfterReplay(): void {
		this._dataFlowControl.resetAfterReplay();
	}

	register(clientId: string): void {
		if (!this._clients.has(clientId)) {
			// Stryker disable next-line ObjectLiteral: an absent activation behaves as zero in both the > 0 fallback gate and the next ++ assignment.
			this._clients.set(clientId, { activation: 0 });
		}
		this._dataFlowControl.register(clientId);
	}

	unregister(clientId: string): void {
		this._dataFlowControl.unregister(clientId);
		this._clients.delete(clientId);

		this._activeClient = undefined;
		let next:
			| {
					clientId: string;
					viewport: IViewportDimensions;
					activation: number;
			  }
			| undefined;
		for (const [id, client] of this._clients) {
			if (
				client.viewport &&
				client.activation > 0 &&
				// Stryker disable next-line EqualityOperator: positive activations come from one increasing counter, so two clients can never tie.
				(!next || client.activation > next.activation)
			) {
				next = {
					clientId: id,
					viewport: client.viewport,
					activation: client.activation
				};
			}
		}
		if (next) {
			this._activeClient = next.clientId;
			this.resize(next.viewport);
		}
	}

	resizeViewport(clientId: string, viewport: IViewportDimensions): void {
		this._client(clientId).viewport = viewport;
		if (this._activeClient === clientId) {
			this.resize(viewport);
		}
	}

	activateViewport(clientId: string, viewport: IViewportDimensions): void {
		const client = this._client(clientId);
		client.viewport = viewport;
		client.activation = ++this._activations;
		this._activeClient = clientId;
		this.resize(viewport);
	}

	resize(dimensions: IViewportDimensions): void {
		if (
			this._dimensions.cols === dimensions.cols &&
			this._dimensions.rows === dimensions.rows &&
			this._dimensions.pixelWidth === dimensions.pixelWidth &&
			this._dimensions.pixelHeight === dimensions.pixelHeight
		) {
			return;
		}
		if (this._resize(dimensions)) {
			this._dimensions = dimensions;
		}
	}

	private _client(clientId: string): ITerminalClient {
		const client = this._clients.get(clientId);
		if (!client) {
			throw new Error(`Terminal client "${clientId}" is not registered`);
		}
		return client;
	}
}
