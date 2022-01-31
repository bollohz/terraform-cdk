// This is the programmatic entrypoint that the CLI uses.
// While this is the closest we have to a programmatic API, please understand that the interfaces in this file are not stable.
// Convert is not included here since it's published independently as @cdktf/hcl2cdk.

export { init, Project, InitArgs } from "./init";
export { get, GetStatus } from "./get";
import { interpret, InterpreterFrom } from "xstate";
import { SynthesizedStack } from "../bin/cmds/helper/synth-stack";
import { projectExecutionMachine } from "./project-execution";
import { TerraformPlan } from "../bin/cmds/ui/models/terraform";

// TODO: move files around to all be under lib
export { SynthesizedStack };

export enum Status {
  STARTING = "starting",
  SYNTHESIZING = "synthesizing",
  SYNTHESIZED = "synthesized",
  INITIALIZING = "initializing",
  PLANNING = "planning",
  PLANNED = "planned",
  DEPLOYING = "deploying",
  DESTROYING = "destroying",
  OUTPUT_FETCHED = "output fetched",
  DONE = "done",
}

// TODO: add project state payload (synthesized stacks, diffed stacks, applied stacks, etc)
export type ProjectUpdates =
  | {
      type: "synthing";
    }
  | {
      type: "synthed";
      stacks: SynthesizedStack[];
      errorMessage?: string;
    }
  | {
      type: "diffing";
      stackName: string;
    }
  | {
      type: "diffed";
      stackName: string;
      plan: TerraformPlan;
    }
  | {
      type: "deploying";
      stackName: string;
    }
  | {
      type: "deploy update";
      stackName: string;
      deployOutput: string;
    }
  | {
      type: "deployed";
      stackName: string;
      outputsByConstructId: Record<string, any>;
      outputs: Record<string, any>;
    }
  | {
      type: "destroying";
      stackName: string;
    }
  | {
      type: "destroy update";
      stackName: string;
      destroyOutput: string;
    }
  | {
      type: "destroyed";
      stackName: string;
    };

export class CdktfProject {
  public stateMachine: InterpreterFrom<typeof projectExecutionMachine>;
  public currentState: string;
  public stackName?: string;
  public currentPlan?: TerraformPlan;
  public status: Status;
  public stacks?: SynthesizedStack[];

  constructor({
    synthCommand,
    targetDir,
    onUpdate,
  }: {
    synthCommand: string;
    targetDir: string;
    onUpdate: (update: ProjectUpdates) => void;
  }) {
    this.status = Status.STARTING;
    this.stateMachine = interpret(
      projectExecutionMachine.withContext({
        synthCommand,
        targetDir,

        onProgress: (event) => {
          switch (event.type) {
            case "LOG":
              break;
          }
        },
      })
    );

    this.currentState = "idle";
    this.stateMachine.onTransition((state) => {
      if (!state) {
        return;
      }

      this.currentState = state.toStrings()[0];
      const lastState = (state.history?.toStrings() || [])[0];
      const ctx = state.context;

      switch (lastState) {
        case "synth":
          this.stacks = ctx.synthesizedStacks || [];
          this.status = Status.SYNTHESIZED;
          onUpdate({
            type: "synthed",
            stacks: this.stacks,
            errorMessage: ctx.message,
          });
          break;

        case "diff":
          this.currentPlan = ctx.targetStackPlan;
          this.status = Status.PLANNED;
          onUpdate({
            type: "diffed",
            stackName: ctx.targetStack!,
            plan: ctx.targetStackPlan!,
          });
          break;

        case "gatherOutput": {
          this.status = Status.OUTPUT_FETCHED;
          if (state.context.targetAction === "deploy") {
            onUpdate({
              type: "deployed",
              stackName: ctx.targetStack!,
              outputs: state.context.outputs!,
              outputsByConstructId: state.context.outputsByConstructId!,
            });
          }
          if (state.context.targetAction === "destroy") {
            onUpdate({
              type: "destroyed",
              stackName: ctx.targetStack!,
            });
          }
          break;
        }
      }

      switch (this.currentState) {
        case "synth":
          this.status = Status.SYNTHESIZING;
          onUpdate({
            type: "synthing",
          });
          break;

        case "deploy":
          this.status = Status.DEPLOYING;
          onUpdate({
            type: "deploying",
            stackName: this.stackName!,
          });
          break;

        case "destroy":
          this.status = Status.DEPLOYING;
          onUpdate({
            type: "destroying",
            stackName: this.stackName!,
          });
          break;

        case "diff":
          this.status = Status.PLANNING;
          onUpdate({
            type: "diffing",
            stackName: this.stackName!,
          });
          break;
      }
    });

    this.stateMachine.start();
  }

  private waitOnMachineDone(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.stateMachine.onTransition((state) => {
        if (state.matches("error")) {
          reject(state.context.message);
        } else if (state.matches("done")) {
          resolve("done");
        }
      });
    });
  }

  public async synth() {
    this.stateMachine.send({
      type: "START",
      targetAction: "synth",
    });

    return this.waitOnMachineDone();
  }

  public async diff(stackName?: string) {
    this.stateMachine.send({
      type: "START",
      targetAction: "diff",
      targetStack: stackName,
    });

    return this.waitOnMachineDone();
  }

  public async deploy(stackName: string) {
    this.stateMachine.send({
      type: "START",
      targetAction: "deploy",
      targetStack: stackName,
    });

    return this.waitOnMachineDone();
  }

  public async destroy(stackName: string) {
    this.stateMachine.send({
      type: "START",
      targetAction: "destroy",
      targetStack: stackName,
    });

    return this.waitOnMachineDone();
  }
}
