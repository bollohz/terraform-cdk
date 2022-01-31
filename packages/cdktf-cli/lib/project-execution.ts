// Each action drives itself to completion and exposes updates to the user.

import { assign, createMachine } from "xstate";
// TODO: move this over
import { SynthStack, SynthesizedStack } from "../bin/cmds/helper/synth-stack";
import { Errors } from "./errors";
import { TerraformJson } from "../bin/cmds/ui/terraform-json";
import { TerraformCloud } from "../bin/cmds/ui/models/terraform-cloud";
import { TerraformCli } from "../bin/cmds/ui/models/terraform-cli";
import { TerraformPlan, Terraform } from "../bin/cmds/ui/models/terraform";
import { getConstructIdsForOutputs } from "../bin/cmds/ui/terraform-context";

export type ProjectEvent =
  | {
      type: "START";
      targetAction?: "synth" | "diff" | "deploy" | "destroy";
      targetStack?: string;
    }
  | {
      type: "APPROVAL_ABORTED";
    }
  | {
      type: "APPROVAL_GIVEN";
    };

type ProgressEvent = {
  type: "LOG";
  stackName: string;
  stateName: string;
  stdout: string;
};

export interface ProjectContext {
  targetAction?: "synth" | "diff" | "deploy" | "destroy";
  targetStack?: string;
  message?: string;
  synthesizedStacks?: SynthesizedStack[];
  targetStackPlan?: TerraformPlan;
  autoApprove?: boolean;
  synthCommand: string;
  targetDir: string;
  outputs?: Record<string, any>;
  outputsByConstructId?: Record<string, any>;
  onProgress: (event: ProgressEvent) => void;
}

function getStack(
  context: ProjectContext,
  stackName = context.targetStack
): SynthesizedStack {
  if (!context.synthesizedStacks) {
    throw Errors.Internal(
      "unknown",
      "Trying to access a stack before it has been synthesized"
    );
  }
  if (stackName) {
    const stack = context.synthesizedStacks.find((s) => s.name === stackName);
    if (!stack) {
      throw Errors.Usage("unknown", "Unknown stack: " + stackName);
    }

    return stack;
  }

  if (context.synthesizedStacks.length !== 1) {
    throw Errors.Usage("unknown", "Please select a stack to use");
  }

  return context.synthesizedStacks[0];
}

async function getTerraformClient(
  stack: SynthesizedStack,
  isSpeculative: boolean
): Promise<Terraform> {
  const parsedStack = JSON.parse(stack.content) as TerraformJson;

  if (parsedStack.terraform?.backend?.remote) {
    const tfClient = new TerraformCloud(
      stack,
      parsedStack.terraform?.backend?.remote,
      isSpeculative
    );
    if (await tfClient.isRemoteWorkspace()) {
      return tfClient;
    }
  }
  return new TerraformCli(stack);
}

const services = {
  synthProject: async (context: ProjectContext) => {
    return await SynthStack.synth(context.synthCommand, context.targetDir);
  },
  diff: async (context: ProjectContext) => {
    const stack = getStack(context);
    const terraform = await getTerraformClient(stack, true);
    await terraform.init(); // TODO: send logs from init
    return terraform.plan(context.targetAction === "destroy"); // TODO: send logs from plan
  },
  deploy: async (context: ProjectContext) => {
    const planFile = context.targetStackPlan?.planFile;
    if (!planFile) {
      throw Errors.Internal(
        "unknown",
        "No plan file found, diff needs to be run first"
      );
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(stack, false);

    await terraform.deploy(planFile, (chunk: Buffer) => {
      context.onProgress({
        type: "LOG",
        stackName: stack.name,
        stateName: "deploy",
        stdout: chunk.toString("utf8"),
      });
    });
  },
  destroy: async (context: ProjectContext) => {
    const planFile = context.targetStackPlan?.planFile;
    if (!planFile) {
      throw Errors.Internal(
        "unknown",
        "No plan file found, diff needs to be run first"
      );
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(stack, false);

    await terraform.destroy((chunk: Buffer) => {
      context.onProgress({
        type: "LOG",
        stackName: stack.name,
        stateName: "destroy",
        stdout: chunk.toString("utf8"),
      });
    });
  },
  gatherOutputs: async (context: ProjectContext) => {
    if (context.targetAction === "destroy") {
      return Promise.resolve({});
    }

    const stack = getStack(context);
    const terraform = await getTerraformClient(stack, false);
    const outputs = await terraform.output();
    const outputsByConstructId = getConstructIdsForOutputs(
      JSON.parse(stack.content),
      outputs
    );

    return Promise.resolve({ outputs, outputsByConstructId });
  },
};

const guards = {
  onTargetAction: (
    context: ProjectContext,
    _event: ProjectEvent,
    state: { cond: { value: string } } // https://xstate.js.org/docs/guides/guards.html#custom-guards
  ) => context.targetAction === state.cond.value,
  autoApprove: (context: ProjectContext) => context.autoApprove,
};

// TODO: test every error type
const projectExecutionMachine = createMachine<ProjectContext, ProjectEvent>(
  {
    id: "project",
    initial: "idle",
    context: {
      onProgress: () => {},
      targetAction: "synth",
      targetStack: "stackName",
      message: undefined,
      autoApprove: false,
      synthCommand: "", // TODO: how do we handle unset values?
      targetDir: "",
      outputs: {},
      outputsByConstructId: {},
    },
    states: {
      idle: {
        on: {
          START: {
            target: "synth",
            actions: assign({
              targetAction: (_context, event) => event.targetAction,
              targetStack: (_context, event) => event.targetStack,
            }),
          },
        },
      },
      synth: {
        invoke: {
          id: "synth",
          src: "synthProject",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: [
            {
              target: "done",
              actions: assign({
                synthesizedStacks: (_context, event) => event.data,
              }),
              cond: {
                type: "onTargetAction",
                name: "actionIsSynth",
                value: "synth",
              },
            },
            {
              target: "diff",
              actions: assign({
                synthesizedStacks: (_context, event) => event.data,
              }),
            },
          ],
        },
      },
      diff: {
        invoke: {
          id: "diff",
          src: "diff",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) =>
                `terraform plan errored with: \n${event.data.stderr}`,
            }),
          },
          onDone: [
            {
              target: "done",
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              cond: {
                type: "onTargetAction",
                name: "actionIsDiff",
                value: "diff",
              },
            },
            {
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              target: "approved",
              cond: "autoApprove",
            },
            {
              actions: assign({
                targetStackPlan: (_context, event) => event.data,
              }),
              target: "waitingForApproval",
            },
          ],
        },
      },
      waitingForApproval: {
        on: {
          APPROVAL_ABORTED: {
            target: "done",
          },
          APPROVAL_GIVEN: {
            target: "approved",
          },
        },
      },
      approved: {
        always: [
          {
            target: "deploy",
            cond: {
              type: "onTargetAction",
              name: "actionIsDiff",
              value: "deploy",
            },
          },
          {
            target: "destroy",
            cond: {
              type: "onTargetAction",
              name: "actionIsDiff",
              value: "destroy",
            },
          },
        ],
      },
      deploy: {
        invoke: {
          id: "deploy",
          src: "deploy",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "gatherOutput",
          },
        },
      },
      destroy: {
        invoke: {
          id: "destroy",
          src: "destroy",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "gatherOutput",
          },
        },
      },
      gatherOutput: {
        invoke: {
          id: "gatherOutput",
          src: "gatherOutput",
          onError: {
            target: "error",
            actions: assign({
              message: (_context, event) => event.data,
            }),
          },
          onDone: {
            target: "done",
            actions: assign({
              outputs: (_context, event) => event.data.outputs,
              outputsByConstructId: (_context, event) =>
                event.data.outputsByConstructId,
            }),
          },
        },
      },
      done: {
        type: "final",
      },
      error: {
        type: "final",
      },
    },
  },
  { services, guards: guards as any }
);

export { projectExecutionMachine, guards, services };
