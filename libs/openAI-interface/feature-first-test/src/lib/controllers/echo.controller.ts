import { FastifyReply, FastifyRequest } from 'fastify';
import { EchoService } from '../services';
import { Controller, Post, Req, Res, Inject } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';

@Controller('/echo')
export class EchoController {
  constructor(@Inject(EchoService) private readonly service: EchoService) {}

  @Post()
  @ApiOperation({ summary: 'Echo Endpunkt' })
  async echo(@Req() req: FastifyRequest, @Res() res: FastifyReply) {
    return res.send(this.service.echo(req.body));
  }
}
