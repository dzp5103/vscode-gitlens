import type { Container } from '../container';
import type { GitBranchReference } from '../git/models/reference';
import { command } from '../system/-webview/command';
import { Logger } from '../system/logger';
import { GlCommandBase } from './commandBase';

export interface AiRebaseBranchCommandArgs {
	branch?: GitBranchReference;
	source?: string;
}

@command()
export class AiRebaseBranchCommand extends GlCommandBase {
	constructor(private readonly container: Container) {
		super('gitlens.ai.aiRebaseBranch');
	}

	execute(args?: AiRebaseBranchCommandArgs): void {
		if (args?.branch) {
			Logger.log(`AI Rebase Branch called for: ${args.branch.name}`);
			Logger.log(`Branch details:`, {
				branch: args.branch,
				repoPath: args.branch.repoPath,
			});
			Logger.log(`Source: ${args.source}`);
		} else {
			Logger.log('AI Rebase Branch called but no branch information provided');
		}
	}
}
