import { EventEmitter } from 'node:events';
import mqtt, { MqttClient } from 'mqtt';

/**
 * Talks to ring-mqtt (https://github.com/tsightler/ring-mqtt) over the broker. ring-mqtt does the
 * Ring cloud work; Sentry only listens for camera state and asks for snapshot intervals.
 *
 * Camera topics look like `ring/<location>/camera/<device>/<entity>/<state|image|...>`. Device
 * names come from the Home Assistant discovery configs ring-mqtt publishes under
 * `homeassistant/`, since the state topics only carry ids.
 */

export interface CameraTopic {
  location: string;
  device: string;
  entity: string;
  leaf: string;
}

export function parseCameraTopic(topic: string, ringTopic = 'ring'): CameraTopic | null {
  const parts = topic.split('/');
  // 5 parts for the device-level `.../<device>/status`, 6 for entity topics.
  if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== ringTopic || parts[2] !== 'camera') return null;
  return { location: parts[1], device: parts[3], entity: parts[4], leaf: parts[5] ?? '' };
}

/** Pulls `{ device, name }` out of a discovery config, if it describes a Ring camera entity. */
export function parseDiscovery(topic: string, payload: string, ringTopic = 'ring'): { device: string; location: string; name: string } | null {
  let config: { device?: { name?: string }; state_topic?: string; json_attributes_topic?: string; topic?: string };
  try {
    config = JSON.parse(payload);
  } catch {
    return null;
  }
  const name = config.device?.name;
  const stateTopic = config.state_topic ?? config.json_attributes_topic ?? config.topic;
  if (!name || !stateTopic || !topic.startsWith('homeassistant/')) return null;
  const parsed = parseCameraTopic(stateTopic, ringTopic);
  return parsed ? { device: parsed.device, location: parsed.location, name } : null;
}

export interface RingEvents {
  camera: [id: string, location: string, name: string | null];
  motion: [id: string, on: boolean];
  ding: [id: string, on: boolean];
  snapshot: [id: string, jpeg: Buffer];
  online: [id: string, online: boolean];
  /** what ring-mqtt reports it's actually doing */
  snapshotConfig: [id: string, config: { mode?: string; interval?: number }];
}

export class RingBridge extends EventEmitter<RingEvents> {
  private client?: MqttClient;
  private seen = new Map<string, string>();

  constructor(
    private url: string,
    private log: { info: (msg: string) => void; warn: (msg: string) => void },
    private ringTopic = 'ring',
  ) {
    super();
  }

  get connected() {
    return this.client?.connected ?? false;
  }

  start() {
    const client = mqtt.connect(this.url, { clientId: `sentry-${process.pid}`, reconnectPeriod: 5000 });
    this.client = client;
    client.on('connect', () => {
      this.log.info(`MQTT connected to ${this.url}`);
      client.subscribe([
        `${this.ringTopic}/+/camera/+/motion/state`,
        `${this.ringTopic}/+/camera/+/ding/state`,
        `${this.ringTopic}/+/camera/+/snapshot/image`,
        `${this.ringTopic}/+/camera/+/status`,
        `${this.ringTopic}/+/camera/+/snapshot_mode/state`,
        `${this.ringTopic}/+/camera/+/snapshot_interval/state`,
        'homeassistant/+/+/+/config',
      ]);
      // ring-mqtt only announces devices and state at its own startup, or when it sees Home
      // Assistant come online. Posing as HA makes it republish everything, so a Sentry restart
      // still learns about cameras that ring-mqtt announced earlier.
      client.publish('homeassistant/status', 'online');
    });
    client.on('error', (err) => this.log.warn(`MQTT: ${err.message}`));
    client.on('message', (topic, payload) => this.handle(topic, payload));
  }

  stop() {
    this.client?.end(true);
  }

  /**
   * Turns on interval snapshots (plus motion/ding ones) every `seconds`. The mode has to be set
   * explicitly: ring-mqtt's default "Auto" skips interval snapshots on any camera that reports
   * running on battery, which includes hardwired doorbells that trickle-charge one. ring-mqtt
   * saves both values in its own state file.
   */
  setSnapshots(id: string, location: string, seconds: number) {
    const base = `${this.ringTopic}/${location}/camera/${id}`;
    this.client?.publish(`${base}/snapshot_mode/command`, 'All');
    this.client?.publish(`${base}/snapshot_interval/command`, String(seconds));
  }

  private handle(topic: string, payload: Buffer) {
    if (topic.startsWith('homeassistant/')) {
      const found = parseDiscovery(topic, payload.toString(), this.ringTopic);
      if (found && this.seen.get(found.device) !== found.name) {
        this.seen.set(found.device, found.name);
        this.emit('camera', found.device, found.location, found.name);
      }
      return;
    }
    const t = parseCameraTopic(topic, this.ringTopic);
    if (!t) return;
    // A camera can show up through its state topics before (or without) a discovery config.
    if (!this.seen.has(t.device)) {
      this.seen.set(t.device, '');
      this.emit('camera', t.device, t.location, null);
    }
    const text = () => payload.toString().trim();
    if (t.entity === 'motion' && t.leaf === 'state') this.emit('motion', t.device, text() === 'ON');
    else if (t.entity === 'ding' && t.leaf === 'state') this.emit('ding', t.device, text() === 'ON');
    else if (t.entity === 'snapshot' && t.leaf === 'image' && payload.length > 0) this.emit('snapshot', t.device, payload);
    else if (t.entity === 'status') this.emit('online', t.device, text() === 'online');
    else if (t.entity === 'snapshot_mode' && t.leaf === 'state') this.emit('snapshotConfig', t.device, { mode: text() });
    else if (t.entity === 'snapshot_interval' && t.leaf === 'state') this.emit('snapshotConfig', t.device, { interval: Number(text()) });
  }
}
