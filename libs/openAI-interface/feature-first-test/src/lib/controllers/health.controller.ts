import { HealthService } from '../services';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Controller, Post, Req, Res, Inject } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

@Controller('/health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly service: HealthService) {}

  @Post()
  @ApiOperation({ summary: 'Health Endpunkt' })
  async getStatus(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const status = this.service.getStatus();
    return reply.send(status);
  }
}

