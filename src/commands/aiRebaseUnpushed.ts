import type { Container } from '../container';
import type { GitBranchReference } from '../git/models/reference';
import { command } from '../system/-webview/command';
import { Logger } from '../system/logger';
import { GlCommandBase } from './commandBase';

export interface AiRebaseUnpushedCommandArgs {
	branch?: GitBranchReference;
	source?: string;
}

@command()
export class AiRebaseUnpushedCommand extends GlCommandBase {
	constructor(private readonly container: Container) {
		super('gitlens.ai.aiRebaseUnpushed');
	}

	execute(args?: AiRebaseUnpushedCommandArgs): void {
		if (args?.branch) {
			Logger.log(`AI Rebase Unpushed called for: ${args.branch.name}`);
			Logger.log(`Branch details:`, {
				branch: args.branch,
			});
			Logger.log(`Source: ${args.source}`);
		} else {
			Logger.log('AI Rebase Unpushed called but no branch information provided');
		}
	}
}
