/*---------------------------------------------------------------------------------------------
 * Composery Shortcuts: expose internal workbench services that have no public
 * extension API equivalent. Loaded for side effects from terminal.contribution.ts.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { dispose, IDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, QuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IConfigurationResolverService } from '../../../services/configurationResolver/common/configurationResolver.js';
import { createColorStyleElement, getColorClass, getStandardColors } from './terminalIcon.js';
import { TerminalIconPicker } from './terminalIconPicker.js';

interface IPickedIcon {
	readonly id: string;
	readonly color?: string;
}

interface IColorQuickPickItem extends IQuickPickItem {
	readonly id?: string;
}

CommandsRegistry.registerCommand(
	'composery.shortcuts.pickIcon',
	async (accessor: ServicesAccessor): Promise<IPickedIcon | undefined> => {
		const picker = accessor.get(IInstantiationService).createInstance(TerminalIconPicker);
		try {
			const picked = await picker.pickIcons();
			if (!picked || !ThemeIcon.isThemeIcon(picked)) {
				return undefined;
			}
			return { id: picked.id, color: picked.color?.id };
		} finally {
			picker.dispose();
		}
	}
);

CommandsRegistry.registerCommand(
	'composery.shortcuts.pickColor',
	async (accessor: ServicesAccessor, current?: string): Promise<string | undefined> => {
		const colorTheme = accessor.get(IThemeService).getColorTheme();
		const standardColors = getStandardColors(colorTheme);
		const colorStyleDisposable = createColorStyleElement(colorTheme);
		const items: Array<IColorQuickPickItem | QuickPickItem> = [];
		for (const colorKey of standardColors) {
			items.push({
				label: `$(${Codicon.circleFilled.id}) ${colorKey.replace('terminal.ansi', '')}`,
				id: colorKey,
				description: colorKey,
				iconClasses: [getColorClass(colorKey)]
			});
		}
		items.push({ type: 'separator' });
		items.push({ label: 'Reset to default', id: '' });

		const disposables: IDisposable[] = [];
		const quickPick = accessor.get(IQuickInputService).createQuickPick({ useSeparators: true });
		disposables.push(quickPick);
		quickPick.items = items;
		quickPick.matchOnDescription = true;
		quickPick.placeholder = 'Select a color for the terminal';
		if (current) {
			quickPick.activeItems = items.filter(
				(item): item is IColorQuickPickItem => 'id' in item && item.id === current
			);
		}
		quickPick.show();
		try {
			return await new Promise<string | undefined>((resolve) => {
				disposables.push(quickPick.onDidHide(() => resolve(undefined)));
				disposables.push(
					quickPick.onDidAccept(() => {
						resolve((quickPick.selectedItems[0] as IColorQuickPickItem | undefined)?.id);
					})
				);
			});
		} finally {
			dispose(disposables);
			quickPick.hide();
			colorStyleDisposable.dispose();
		}
	}
);

CommandsRegistry.registerCommand(
	'composery.shortcuts.resolveVariables',
	async (accessor: ServicesAccessor, value: string): Promise<string> => {
		if (typeof value !== 'string' || value.length === 0) {
			return value;
		}
		const resolver = accessor.get(IConfigurationResolverService);
		const folder = accessor.get(IWorkspaceContextService).getWorkspace().folders[0];
		return resolver.resolveAsync(folder, value);
	}
);
