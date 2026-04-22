import { Module } from '@nestjs/common';
import { DriverFactory } from './driver.factory';
import { SshTunnelService } from './ssh-tunnel.service';

@Module({
  providers: [DriverFactory, SshTunnelService],
  exports: [DriverFactory, SshTunnelService],
})
export class DriversModule {}
