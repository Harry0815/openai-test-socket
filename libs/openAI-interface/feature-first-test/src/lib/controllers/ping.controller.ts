import { FastifyReply, FastifyRequest } from 'fastify';
import { Controller, Post, Req, Res, Inject } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { PingService } from '../services';

export interface PingQuery {
  name?: string;
}

@Controller('/ping')
export class PingController {
  constructor(@Inject(PingService) private readonly service: PingService) {}

  @Post()
  @ApiOperation({ summary: 'Ping Endpunkt' })
  async ping(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const { name } = (request.query as PingQuery | undefined) ?? {};
    const response = this.service.ping(name);
    return reply.send(response);
  }
}
