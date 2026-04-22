import { Module } from '@nestjs/common';
import { DriverFactory } from './driver.factory';

@Module({
  providers: [DriverFactory],
  exports: [DriverFactory],
})
export class DriversModule {}
