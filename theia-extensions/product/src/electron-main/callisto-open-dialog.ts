/********************************************************************************
 * Copyright (C) 2026 Callisto.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { injectable } from '@theia/core/shared/inversify';
import { ipcMain, BrowserWindow, dialog, OpenDialogOptions } from '@theia/core/electron-shared/electron';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { ElectronApi } from '@theia/filesystem/lib/electron-main/electron-api-main';
import { CHANNEL_SHOW_OPEN, OpenDialogOptions as TheiaOpenDialogOptions } from '@theia/filesystem/lib/electron-common/electron-api';

/**
 * Theia's native Open dialog never asks Electron for `createDirectory`, so on macOS the
 * panel has no "New Folder" button. This keeps Theia's handlers (Save stays untouched) and
 * re-registers only the Open handler with that property added.
 */
@injectable()
export class CallistoOpenDialogApi extends ElectronApi {

    override onStart(application: ElectronMainApplication): void {
        super.onStart(application);
        ipcMain.removeHandler(CHANNEL_SHOW_OPEN);
        ipcMain.handle(CHANNEL_SHOW_OPEN, async (event, options: TheiaOpenDialogOptions) => {
            // Same mapping as Theia's handler, plus 'createDirectory' (macOS only; ignored elsewhere).
            const properties: OpenDialogOptions['properties'] = ['createDirectory'];
            if (options.openFiles) {
                properties.push('openFile');
            }
            if (options.openFolders) {
                properties.push('openDirectory');
            }
            if (options.selectMany === true) {
                properties.push('multiSelections');
            }
            const dialogOpts: OpenDialogOptions = {
                defaultPath: options.path,
                buttonLabel: options.buttonLabel,
                filters: options.filters,
                title: options.title,
                properties
            };
            if (options.modal) {
                const win = options.windowName
                    ? BrowserWindow.getAllWindows().find(w => w.webContents.mainFrame.name === options.windowName)
                    : BrowserWindow.fromWebContents(event.sender);
                if (win) {
                    return (await dialog.showOpenDialog(win, dialogOpts)).filePaths;
                }
            }
            return (await dialog.showOpenDialog(dialogOpts)).filePaths;
        });
    }
}
