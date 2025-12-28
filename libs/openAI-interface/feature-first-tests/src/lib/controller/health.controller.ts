import { HealthService } from '../services/health.service';
import { FastifyReply, FastifyRequest } from 'fastify';
import { Controller, Post, Req, Res } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

@Controller('/health')
export class HealthController {
  constructor(private readonly service: HealthService = new HealthService()) {}

  @Post()
  @ApiOperation({ summary: 'Health Endpunkt' })
  async getStatus(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const status = this.service.getStatus();
    return reply.send(status);
  }
}

