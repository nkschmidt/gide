import { ProjectRepositoriesWidget } from './project-repositories-widget';
import { WorkspaceCommandContribution } from '@theia/workspace/lib/browser/workspace-commands';
import { ProjectWorkspaceCommands } from './project-workspace-commands';
/********************************************************************************
 * Copyright (C) 2020 TypeFox, EclipseSource and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 *
 * SPDX-License-Identifier: MIT
 ********************************************************************************/

import '../../src/browser/style/index.css';

import { FrontendApplicationContribution, WidgetFactory } from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common/command';
import { ContainerModule } from '@theia/core/shared/inversify';
import { MenuContribution } from '@theia/core/lib/common/menu';
import { LocalModelStatusContribution } from './local-model-status';
import { TheiaIDEContribution } from './theia-ide-contribution';
import { GovernanceWidget } from './governance-widget';
import { ProjectChatWidget } from './project-chat-widget';
import { ProjectContextWidget } from './project-context-widget';
import { WorkflowWidget } from './workflow-widget';
import { ToolsWidget } from './tools-widget';
import { ProjectToolService, ProjectToolServicePath } from '../common/project-tool-service';
import { WorkflowService, WorkflowServicePath } from '../common/workflow-service';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ProjectService, ProjectServicePath } from '../common/project-service';
import { TaskService, TaskServicePath } from '../common/task-service';
import { WorkspaceDeleteHandler } from '@theia/workspace/lib/browser/workspace-delete-handler';
import { ProjectDeleteHandler } from './project-delete-handler';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(WorkspaceCommandContribution).to(ProjectWorkspaceCommands).inSingletonScope();
    rebind(WorkspaceDeleteHandler).to(ProjectDeleteHandler).inSingletonScope();

    bind(TheiaIDEContribution).toSelf().inSingletonScope();
    bind(LocalModelStatusContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(LocalModelStatusContribution);
    bind(CommandContribution).toService(LocalModelStatusContribution);
    bind(GovernanceWidget).toSelf();
    bind(ProjectChatWidget).toSelf();
    bind(ProjectContextWidget).toSelf();
    bind(ProjectRepositoriesWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(context => ({ id: ProjectRepositoriesWidget.ID, createWidget: () => context.container.get(ProjectRepositoriesWidget) })).inSingletonScope();
    bind(WorkflowWidget).toSelf();
    bind(ToolsWidget).toSelf();
    bind(ProjectToolService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, ProjectToolServicePath)).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({ id: ToolsWidget.ID, createWidget: () => context.container.get<ToolsWidget>(ToolsWidget) })).inSingletonScope();
    bind(WorkflowService).toDynamicValue(context => WebSocketConnectionProvider.createProxy(context.container, WorkflowServicePath)).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({ id: WorkflowWidget.ID, createWidget: () => context.container.get<WorkflowWidget>(WorkflowWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({ id: ProjectContextWidget.ID, createWidget: () => context.container.get<ProjectContextWidget>(ProjectContextWidget) })).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: ProjectChatWidget.ID,
        createWidget: () => context.container.get<ProjectChatWidget>(ProjectChatWidget),
    })).inSingletonScope();
    bind(ProjectService).toDynamicValue(ctx => WebSocketConnectionProvider.createProxy(ctx.container, ProjectServicePath)).inSingletonScope();
    bind(TaskService).toDynamicValue(ctx => WebSocketConnectionProvider.createProxy(ctx.container, TaskServicePath)).inSingletonScope();
    bind(WidgetFactory).toDynamicValue(context => ({
        id: GovernanceWidget.ID,
        createWidget: () => context.container.get<GovernanceWidget>(GovernanceWidget),
    })).inSingletonScope();
    [CommandContribution, MenuContribution, FrontendApplicationContribution].forEach(serviceIdentifier =>
        bind(serviceIdentifier).toService(TheiaIDEContribution)
    );
});
