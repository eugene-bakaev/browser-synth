import { ModulePort } from './types';

export class PatchBay {
  connect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
      if (target instanceof AudioNode) {
        source.connect(target);
      } else if (target instanceof AudioParam) {
        source.connect(target);
      }
    } else {
        throw new Error("Source must be an AudioNode to connect to a target.");
    }
  }

  disconnect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
        if (target instanceof AudioNode) {
            source.disconnect(target);
        } else if (target instanceof AudioParam) {
            source.disconnect(target);
        }
    }
  }
}
