import type {
  ClassifyInput,
  ClassifyOutput,
  ExtractInput,
  ExtractOutput,
  ILlmProvider,
} from '../../types.js'

/**
 * Injectable stub for tests.
 *
 * Callers pre-wire fixed responses; the stub throws if called more times than
 * responses were queued, making missing stubs an immediate test failure rather
 * than a silent wrong answer.
 */
export class StubLlmProvider implements ILlmProvider {
  private classifyQueue: ClassifyOutput[] = []
  private extractQueue: ExtractOutput[] = []

  queueClassify(output: ClassifyOutput): this {
    this.classifyQueue.push(output)
    return this
  }

  queueExtract(output: ExtractOutput): this {
    this.extractQueue.push(output)
    return this
  }

  async classify(_input: ClassifyInput): Promise<ClassifyOutput> {
    const output = this.classifyQueue.shift()
    if (!output) throw new Error('StubLlmProvider: classify queue is empty')
    return output
  }

  async extract(_input: ExtractInput): Promise<ExtractOutput> {
    const output = this.extractQueue.shift()
    if (!output) throw new Error('StubLlmProvider: extract queue is empty')
    return output
  }
}
