import { ProjectRepositoriesWidget } from './project-repositories-widget';
/********************************************************************************
 * Copyright (C) 2021 Ericsson and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import { inject, injectable } from '@theia/core/shared/inversify';
import { CommonMenus } from '@theia/core/lib/browser/common-frontend-contribution';
import { Command, CommandContribution, CommandRegistry } from '@theia/core/lib/common/command';
import { MenuContribution, MenuModelRegistry, MenuPath } from '@theia/core/lib/common/menu';
import { WindowService } from '@theia/core/lib/browser/window/window-service';
import { ApplicationShell, FrontendApplicationContribution, WidgetManager } from '@theia/core/lib/browser';
import { GovernanceWidget } from './governance-widget';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FrontendApplicationStateService } from '@theia/core/lib/browser/frontend-application-state';
import { ProjectChatWidget } from './project-chat-widget';
import { ProjectContextWidget } from './project-context-widget';
import { WorkflowWidget } from './workflow-widget';
import { ToolsWidget } from './tools-widget';

export namespace TheiaIDEMenus {
    export const THEIA_IDE_HELP: MenuPath = [...CommonMenus.HELP, 'theia-ide'];
}
export namespace TheiaIDECommands {
    export const OPEN_REPOSITORIES: Command = { id: 'governed-ide:open-repositories', category: 'Governed IDE', label: 'Project Repositories' };
    export const OPEN_WORKFLOW: Command = { id: 'governed-ide:open-workflow', category: 'Governed IDE', label: 'Project Workflow' };
    export const OPEN_TOOLS: Command = { id: 'governed-ide:open-tools', category: 'Governed IDE', label: 'Project Tools' };
    export const OPEN_CONTEXT: Command = { id: 'governed-ide:open-context', category: 'Governed IDE', label: 'Project Context' };
    export const CATEGORY = 'TheiaIDE';
    export const REPORT_ISSUE: Command = {
        id: 'theia-ide:report-issue',
        category: CATEGORY,
        label: 'Report Issue'
    };
    export const DOCUMENTATION: Command = {
        id: 'theia-ide:documentation',
        category: CATEGORY,
        label: 'Documentation'
    };
    export const OPEN_GOVERNANCE: Command = {
        id: 'governed-ide:open-governance', category: 'Governed IDE', label: 'Create Project'
    };
    export const OPEN_CHAT: Command = { id: 'governed-ide:open-chat', category: 'Governed IDE', label: 'Open Project Workbench' };
}

@injectable()
export class TheiaIDEContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {

    @inject(WindowService)
    protected readonly windowService: WindowService;

    @inject(WidgetManager)
    protected readonly widgetManager: WidgetManager;

    @inject(ApplicationShell)
    protected readonly shell: ApplicationShell;
    @inject(WorkspaceService)
    protected readonly workspace: WorkspaceService;
    @inject(FrontendApplicationStateService)
    protected readonly applicationState: FrontendApplicationStateService;

    static REPORT_ISSUE_URL = 'https://github.com/eclipse-theia/theia-ide/issues/new?assignees=&labels=&template=bug_report.md';
    static DOCUMENTATION_URL = 'https://theia-ide.org/docs/user_getting_started/';

    registerCommands(commandRegistry: CommandRegistry): void {
        commandRegistry.registerCommand(TheiaIDECommands.REPORT_ISSUE, {
            execute: () => this.windowService.openNewWindow(TheiaIDEContribution.REPORT_ISSUE_URL, { external: true })
        });
        commandRegistry.registerCommand(TheiaIDECommands.DOCUMENTATION, {
            execute: () => this.windowService.openNewWindow(TheiaIDEContribution.DOCUMENTATION_URL, { external: true })
        });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_GOVERNANCE, { execute: () => this.openGovernance() });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_CHAT, { execute: (taskId?: string) => this.openChat(taskId), isEnabled: () => this.isProjectOpen() });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_CONTEXT, { execute: () => this.openContext(), isEnabled: () => this.isProjectOpen() });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_WORKFLOW, { execute: () => this.openWorkflow(), isEnabled: () => this.isProjectOpen() });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_REPOSITORIES, { execute: () => this.openRepositories(), isEnabled: () => this.isProjectOpen() });
        commandRegistry.registerCommand(TheiaIDECommands.OPEN_TOOLS, { execute: () => this.openTools(), isEnabled: () => this.isProjectOpen() });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(TheiaIDEMenus.THEIA_IDE_HELP, {
            commandId: TheiaIDECommands.REPORT_ISSUE.id,
            label: TheiaIDECommands.REPORT_ISSUE.label,
            order: '1'
        });
        menus.registerMenuAction(TheiaIDEMenus.THEIA_IDE_HELP, {
            commandId: TheiaIDECommands.DOCUMENTATION.id,
            label: TheiaIDECommands.DOCUMENTATION.label,
            order: '2'
        });
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, {
            commandId: TheiaIDECommands.OPEN_GOVERNANCE.id,
            label: TheiaIDECommands.OPEN_GOVERNANCE.label,
            order: '9'
        });
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: TheiaIDECommands.OPEN_CHAT.id, label: 'Project Workbench', order: '0' });
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: TheiaIDECommands.OPEN_CONTEXT.id, label: 'Project Context', order: '1' });
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: TheiaIDECommands.OPEN_WORKFLOW.id, label: 'Project Workflow', order: '2' });
        menus.registerMenuAction(CommonMenus.VIEW_VIEWS, { commandId: TheiaIDECommands.OPEN_TOOLS.id, label: 'Project Tools', order: '3' });
    }

    protected async openGovernance(): Promise<void> {
        const widget = await this.widgetManager.getOrCreateWidget(GovernanceWidget.ID);
        await this.shell.addWidget(widget, { area: 'main', rank: 0 });
        this.shell.activateWidget(widget.id);
    }

    protected isProjectOpen(): boolean {
        return !!this.workspace.workspace?.resource.path.toString().endsWith('/project.theia-workspace');
    }

    protected async openWorkflow(): Promise<void> {
        if (!this.isProjectOpen()) return;
        const widget = await this.widgetManager.getOrCreateWidget(WorkflowWidget.ID);
        if (!this.shell.getAreaFor(widget)) await this.shell.addWidget(widget, { area: 'main' });
        this.shell.activateWidget(widget.id);
    }
    protected async openRepositories(): Promise<void> {
        if (!this.isProjectOpen()) return;
        const widget = await this.widgetManager.getOrCreateWidget(ProjectRepositoriesWidget.ID);
        if (!this.shell.getAreaFor(widget)) await this.shell.addWidget(widget, { area: 'main' });
        this.shell.activateWidget(widget.id);
    }
    protected async openTools(): Promise<void> {
        if (!this.isProjectOpen()) return;
        const widget = await this.widgetManager.getOrCreateWidget(ToolsWidget.ID);
        if (!this.shell.getAreaFor(widget)) await this.shell.addWidget(widget, { area: 'main' });
        this.shell.activateWidget(widget.id);
    }
    protected async openContext(): Promise<void> {
        if (!this.isProjectOpen()) return;
        const widget = await this.widgetManager.getOrCreateWidget(ProjectContextWidget.ID);
        if (!this.shell.getAreaFor(widget)) await this.shell.addWidget(widget, { area: 'main' });
        this.shell.activateWidget(widget.id);
    }
    protected async openChat(taskId?: string): Promise<void> {
        if (!this.isProjectOpen()) return;
        const widget = await this.widgetManager.getOrCreateWidget(ProjectChatWidget.ID);
        if (!this.shell.getAreaFor(widget)) await this.shell.addWidget(widget, { area: 'main', rank: 0 });
        this.pinChat(); this.shell.activateWidget(widget.id);
        if (taskId && widget instanceof ProjectChatWidget) widget.revealTask(taskId);
    }

    protected pinChat(): void {
        const chat = this.shell.getWidgets('main').find(widget => widget.id === ProjectChatWidget.ID);
        if (!chat) return;
        const tabBar = this.shell.getTabBarFor(chat);
        if (tabBar && tabBar.titles.indexOf(chat.title) > 0) tabBar.insertTab(0, chat.title);
    }

    onStart(): void {
        // Run after layout restoration, so the pinned tab survives reloads reliably.
        void this.applicationState.reachedState('ready').then(async () => {
            await this.workspace.ready;
            void this.shell.rightPanelHandler.collapse();
            this.shell.rightPanelHandler.container.hide();
            this.shell.rightPanelHandler.tabBar.hide();
            this.shell.rightPanelHandler.topMenu.hide();
            this.shell.rightPanelHandler.bottomMenu.hide();
            this.shell.mainPanel.layoutModified.connect(() => queueMicrotask(() => this.pinChat()));
            this.shell.onDidAddWidget(() => queueMicrotask(() => this.pinChat()));
            this.workspace.onWorkspaceLocationChanged(() => { if (this.isProjectOpen()) void this.openChat(); });
            if (this.isProjectOpen()) await this.openChat();
            else await this.openGovernance();
        });
    }
}
