/*---------------------------------------------------------------------------------------------
 * Composery: the activity bar location on a narrow viewport, as a setting of its own.
 *
 * `workbench.activityBar.location` and `composery.activityBar.narrowLocation` are two
 * independent settings - the upstream one governs every viewport except a narrow one, ours
 * governs a narrow one and nothing else. One key could not have served both: a phone and a
 * desktop browser pointed at the same Composery share one settings file, so whichever client wrote
 * last would have moved the other client's activity bar.
 *
 * The narrow default is `bottom`. A narrow viewport shows the side bar fullscreen (see the
 * narrow layout in layout.ts) and `bottom` renders the icon row at the foot of the side bar, so
 * the row lands at the bottom of the screen, under a thumb. `default` would instead spend a
 * column of a phone's width on a vertical strip.
 *
 * Rather than teach the twenty-odd readers of ACTIVITY_BAR_LOCATION about a second key, the
 * narrow value is mirrored onto the upstream key in the memory configuration target, which
 * outranks user settings and is never persisted. Everything downstream then sees one ordinary
 * change of one ordinary key and needs no teaching at all - not the parts, not the
 * `affectsConfiguration` listeners, not the `config.workbench.activityBar.location` context key
 * behind the menu items. Writes travel the other way, through `activityBarLocationKey`: while
 * the viewport is narrow that is the narrow key, so repositioning the activity bar from the
 * phone lands in the narrow setting and leaves the desktop one untouched.
 *
 * Install order is load-bearing, which is why this is a function the workbench calls rather than
 * a workbench contribution. The first mirror has to happen after the configuration service will
 * accept writes (it is handed its instantiation service in Workbench.initServices) and before
 * Layout.initLayout, which both seeds ACTIVITYBAR_HIDDEN from this setting and subscribes to
 * changes of it. Mirroring any later is not a cosmetic problem: the subscription runs
 * setActivityBarHidden, which dereferences a workbenchGrid that createWorkbenchLayout has not
 * assigned yet. Every contribution phase, BlockStartup included, is already too late.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../base/browser/window.js';
import { DisposableStore, IDisposable, toDisposable } from '../../base/common/lifecycle.js';
import { localize } from '../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../platform/configuration/common/configuration.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../platform/registry/common/platform.js';
import { workbenchConfigurationNodeBase } from '../common/configuration.js';
import { ActivityBarPosition, LayoutSettings } from '../services/layout/browser/layoutService.js';
import { isNarrow, NARROW_MAX_WIDTH, NARROW_QUERY } from './narrowGate.js';

const NARROW_DEFAULT = ActivityBarPosition.BOTTOM;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	...workbenchConfigurationNodeBase,
	properties: {
		// The values are upstream's, taken from the same enum so the two lists cannot drift.
		[LayoutSettings.NARROW_ACTIVITY_BAR_LOCATION]: {
			'type': 'string',
			'enum': [ActivityBarPosition.DEFAULT, ActivityBarPosition.TOP, ActivityBarPosition.BOTTOM, ActivityBarPosition.HIDDEN],
			'default': NARROW_DEFAULT,
			'markdownDescription': localize('narrowActivityBarLocation', "Controls the location of the Activity Bar on a viewport narrower than {0}px, where it replaces {1} rather than refining it. The values mean what they mean there.", NARROW_MAX_WIDTH, '`#workbench.activityBar.location#`')
		}
	}
});

/**
 * Composery: which of the two activity bar location settings governs the viewport right now.
 * The one home for that question - the configuration service redirects writes through it, and
 * the side bar keys its remembered-position storage off it.
 */
export function activityBarLocationKey(): LayoutSettings {
	return isNarrow(mainWindow) ? LayoutSettings.NARROW_ACTIVITY_BAR_LOCATION : LayoutSettings.ACTIVITY_BAR_LOCATION;
}

/**
 * Composery: the default of whichever setting governs the viewport right now, for callers that
 * need somewhere to land when nothing has been chosen or remembered.
 */
export function activityBarLocationDefault(): ActivityBarPosition {
	return isNarrow(mainWindow) ? NARROW_DEFAULT : ActivityBarPosition.DEFAULT;
}

export function installNarrowActivityBarLocation(configurationService: IConfigurationService): IDisposable {
	const disposables = new DisposableStore();
	let mirrored: ActivityBarPosition | undefined;

	// Off a narrow viewport the mirror is removed rather than set to the wide setting's value:
	// the wide setting has to keep governing itself, its own default included. The no-op guard
	// keeps a desktop session - where there is nothing to mirror and never will be - from writing
	// and broadcasting a configuration change nobody asked for.
	const mirror = () => {
		const key = activityBarLocationKey();
		const location = key === LayoutSettings.NARROW_ACTIVITY_BAR_LOCATION
			? configurationService.getValue<ActivityBarPosition>(key)
			: undefined;
		if (location === mirrored) {
			return;
		}

		mirrored = location;
		configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, location, ConfigurationTarget.MEMORY);
	};

	mirror();

	// A phone rotated into landscape is wider than the breakpoint, so which of the two settings
	// applies changes within one session and the mirror has to follow. This query is the change
	// source only - the answer always comes from the gate, so there is one way to ask.
	const narrow = mainWindow.matchMedia(NARROW_QUERY);
	const onNarrowChange = () => mirror();
	narrow.addEventListener('change', onNarrowChange);
	disposables.add(toDisposable(() => narrow.removeEventListener('change', onNarrowChange)));

	disposables.add(configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(LayoutSettings.NARROW_ACTIVITY_BAR_LOCATION)) {
			mirror();
		}
	}));

	return disposables;
}
