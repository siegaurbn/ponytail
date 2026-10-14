class WhepPlayer {
  async stop() {
    this.pc?.close(); this.pc = null;
    const location = this.location; this.location = null;
    if (location) await this.request(location, { method: 'DELETE' }).catch(() => {});
    this.video.srcObject = null;
  }
  constructor(video, request) { this.video = video; this.request = request; }
  async play(doorId) {
    await this.stop();
    const pc = this.pc = new RTCPeerConnection();
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.ontrack = event => { this.video.srcObject = event.streams[0] || new MediaStream([event.track]); };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((resolve, reject) => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(() => reject(new Error('Не удалось подключить камеру')), 8000);
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(timer); resolve(); } };
      });
      const response = await this.request(`/api/doors/${doorId}/whep`, { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: pc.localDescription.sdp });
      this.location = response.headers.get('location');
      await pc.setRemoteDescription({ type: 'answer', sdp: await response.text() });
      await this.video.play();
    } catch (error) { await this.stop(); throw error; }
  }
}
